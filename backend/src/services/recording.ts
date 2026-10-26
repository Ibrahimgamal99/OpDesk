/**
 * Call recordings on disk: where they live (the recordings root and the basename -> path
 * index), the sandbox the audio route serves from, the recording policy snapshot the
 * Settings page shows, retention and storage statistics, and the deletes -- one recording
 * from the Recordings page, a ring-only recording of an unanswered call, the per-speaker
 * legs once VAD has used them.
 *
 * Storage is local only: OpDesk keeps no remote (S3) copy, so retention never has to wait
 * for a backup before deleting.
 */

import * as fs from 'fs';
import { env } from '../core/config';
import { getLogger, pyStr } from '../core/logger';
import { AsyncLock, monotonic, pyInt, time, truthy } from '../core/py';
import * as dbm from '../db/db-manager';
import type { Row } from '../db/pool';
import { getRecordingPolicy, RECORD_MIX_DIR, RECORD_SINGLE_DIR, recordingHookConflicts } from './dialplan';
import { refused, shadowMode } from '../core/shadow';

const log = getLogger('services.recording');

const SEP = '/';

// ---------------------------------------------------------------------------
// The recordings root
// ---------------------------------------------------------------------------

// Where recordings are looked up, served from and deleted by retention: the directory the
// dialplan's MixMonitor writes the mixed file to (dialplan.RECORD_MIX_DIR, the FreePBX/Issabel
// $ASTSPOOLDIR/monitor). It is NOT an admin setting any more: the recorder always writes
// there, so a directory moved in Settings only made every recording unfindable -- and pointed
// retention, which deletes audio under the root, at a tree OpDesk does not write. A
// RECORDING_ROOT_DIR row an earlier version saved is ignored. The env var stays for a
// deployment that mounts the spool at another path (it is install-time configuration, not a
// screen setting).
/** Retired: the Settings key the recordings directory used to be stored under (now ignored). */
export const RECORDING_ROOT_SETTING = 'RECORDING_ROOT_DIR';
export const RECORDING_ROOT_ENV = 'ASTERISK_RECORDING_ROOT_DIR';
export const DEFAULT_RECORDING_ROOT = `${RECORD_MIX_DIR}/`;

// Retention and leg-cleanup settings (OpDesk_settings).
export const LOCAL_RETENTION_DAYS_SETTING = 'RECORDING_LOCAL_RETENTION_DAYS';
export const LOCAL_MAX_BYTES_SETTING = 'RECORDING_LOCAL_MAX_SIZE_BYTES';
export const VAD_DELETE_LEGS_SETTING = 'VAD_DELETE_SINGLE_LEGS_ENABLED';

// The only files retention and the deletes ever remove: the formats MixMonitor and
// FreePBX's recorder write. A misconfigured root can then cost recordings, never the
// rest of a directory tree.
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.wav', '.wav49', '.gsm', '.g722', '.ulaw', '.alaw', '.sln', '.mp3', '.ogg', '.opus',
]);

/** str(Path(p)): collapses repeated and trailing slashes and '.' segments (not '..'). */
export function pathlibStr(p: string): string {
  const lead = p.startsWith('//') && !p.startsWith('///') ? '//' : p.startsWith('/') ? '/' : '';
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  return lead + parts.join('/') || '.';
}

/**
 * Absolute root of the recordings tree: env ASTERISK_RECORDING_ROOT_DIR when the deployment
 * sets one, else the directory the dialplan records to. Normalised the way pathlib.Path
 * normalises it (no trailing slash). A root less than two levels deep ('/', '/var') is
 * refused for the default -- retention deletes from this tree.
 */
export async function recordingRoot(): Promise<string> {
  const raw = env(RECORDING_ROOT_ENV, '').trim();
  const root = pathlibStr(raw || DEFAULT_RECORDING_ROOT);
  if (raw && (!isAbs(root) || root.replace(/^\/+/, '').split(SEP).length < 2)) {
    log.warning('Ignoring %s=%s: not an absolute directory below the filesystem root', RECORDING_ROOT_ENV, raw);
    return pathlibStr(DEFAULT_RECORDING_ROOT);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Recording path resolution
//
// The recording filename stored in the CDR is usually only a basename; the file lives
// somewhere under the root (FreePBX nests them under YYYY/MM/DD/). Resolving it used to mean
// a recursive walk of the whole tree PER CALL. Instead one {basename -> absolute path} index
// is built and cached: hits are O(1), the tree is walked at most once per TTL however many
// calls a page has, and a miss (a recording that landed after the last build) triggers at
// most one throttled rebuild so brand-new recordings are still found.
// ---------------------------------------------------------------------------
let REC_INDEX: Map<string, string> = new Map();
let REC_INDEX_BUILT_AT = 0.0; // monotonic timestamp of last successful build
export const REC_INDEX_TTL = 120.0; // seconds a built index is trusted before refresh
export const REC_MISS_REBUILD_INTERVAL = 15.0; // min seconds between miss-triggered rebuilds
// The rebuild awaits the filesystem, so concurrent callers interleave; the lock keeps it to
// one walk at a time.
const REC_INDEX_LOCK = new AsyncLock();

/** Walk the recordings tree once and map each file's basename to its path. */
export async function buildRecordingIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // recordings dir missing / unreadable: whatever we have (maybe nothing)
    }
    for (const entry of entries) {
      const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFileEntry = (await fs.promises.stat(full)).isFile();
        } catch {
          isFileEntry = false;
        }
      }
      // Last write wins if two dirs hold the same basename; recording filenames are unique
      // in practice (they embed the uniqueid).
      if (isFileEntry) index.set(entry.name, full);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(await recordingRoot());
  return index;
}

/**
 * Drop the cached index so the next lookup rebuilds it. Called when the recordings root
 * changes and after a delete, so no lookup keeps resolving to a path that is gone.
 */
export async function invalidateRecordingIndex(): Promise<void> {
  await REC_INDEX_LOCK.run(() => {
    REC_INDEX = new Map();
    REC_INDEX_BUILT_AT = 0.0;
  });
}

/** Return the cached basename->path index, rebuilding when stale or forced. */
export async function getRecordingIndex(force = false): Promise<Map<string, string>> {
  const fresh = () => !force && REC_INDEX_BUILT_AT && monotonic() - REC_INDEX_BUILT_AT < REC_INDEX_TTL;
  if (fresh()) return REC_INDEX;
  return REC_INDEX_LOCK.run(async () => {
    if (fresh()) return REC_INDEX; // another caller rebuilt it while we waited
    REC_INDEX = await buildRecordingIndex();
    REC_INDEX_BUILT_AT = monotonic();
    return REC_INDEX;
  });
}

/**
 * Resolve a CDR recording filename to its on-disk path via the cached index.
 *
 * Accepts a basename or a stored path (IssabelPBX and some FreePBX versions store the full
 * or the YYYY/MM/DD path): the basename is looked up first. Falls back to one throttled
 * rebuild and finally a substring scan of the in-memory index (no disk I/O).
 */
export async function getRecordingPath(fileWav: unknown): Promise<string | null> {
  if (!truthy(fileWav)) return null;
  const name = pyBasename(pyStr(fileWav));
  let index = await getRecordingIndex();

  let hit = index.get(name);
  if (hit !== undefined) return hit;

  if (monotonic() - REC_INDEX_BUILT_AT >= REC_MISS_REBUILD_INTERVAL) {
    index = await getRecordingIndex(true);
    hit = index.get(name);
    if (hit !== undefined) return hit;
  }

  const needle = pyStr(fileWav);
  for (const [basename, p] of index) {
    if (basename.includes(needle) || p.includes(needle)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// posixpath helpers with Python's semantics (the audio sandbox check depends on them)
// ---------------------------------------------------------------------------

/** os.path.isabs */
export function isAbs(p: string): boolean {
  return p.startsWith(SEP);
}

/** os.path.join(a, b) for two parts. */
export function pyJoin(a: string, b: string): string {
  if (b.startsWith(SEP)) return b;
  if (a === '' || a.endsWith(SEP)) return a + b;
  return a + SEP + b;
}

/** os.path.basename: everything after the last '/', so 'x/' -> ''. */
export function pyBasename(p: string): string {
  return p.slice(p.lastIndexOf(SEP) + 1);
}

function pyDirname(p: string): string {
  const i = p.lastIndexOf(SEP) + 1;
  let head = p.slice(0, i);
  if (head && head !== SEP.repeat(head.length)) head = head.replace(/\/+$/, '');
  return head;
}

/** os.path.normpath (posix). */
export function pyNormpath(p: string): string {
  if (p === '') return '.';
  let initialSlashes = p.startsWith(SEP) ? 1 : 0;
  if (initialSlashes && p.startsWith('//') && !p.startsWith('///')) initialSlashes = 2;
  const newComps: string[] = [];
  for (const comp of p.split(SEP)) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initialSlashes && !newComps.length) || (newComps.length && newComps[newComps.length - 1] === '..')) {
      newComps.push(comp);
    } else if (newComps.length) {
      newComps.pop();
    }
  }
  return SEP.repeat(initialSlashes) + newComps.join(SEP) || '.';
}

/**
 * os.path.realpath(path) (non-strict): components are walked left to right and each
 * symlink is resolved BEFORE a following '..' is applied, as Python does -- a lexical
 * normalisation first would let 'link/../x' land somewhere else. A component that does not
 * exist is kept as written.
 */
export async function pyRealpath(filename: string): Promise<string> {
  const seen = new Map<string, string | null>();
  const joinRealpath = async (start: string, rest: string): Promise<[string, boolean]> => {
    let p = start;
    if (isAbs(rest)) {
      rest = rest.slice(1);
      p = SEP;
    }
    while (rest) {
      const idx = rest.indexOf(SEP);
      const name = idx === -1 ? rest : rest.slice(0, idx);
      rest = idx === -1 ? '' : rest.slice(idx + 1);
      if (!name || name === '.') continue;
      if (name === '..') {
        if (p) {
          const tail = pyBasename(p);
          p = pyDirname(p);
          if (tail === '..') p = pyJoin(pyJoin(p, '..'), '..');
        } else {
          p = '..';
        }
        continue;
      }
      const newpath = pyJoin(p, name);
      let isLink = false;
      try {
        isLink = (await fs.promises.lstat(newpath)).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (!isLink) {
        p = newpath;
        continue;
      }
      if (seen.has(newpath)) {
        const known = seen.get(newpath) ?? null;
        if (known !== null) {
          p = known;
          continue;
        }
        return [pyJoin(newpath, rest), false]; // symlink loop
      }
      seen.set(newpath, null);
      let ok: boolean;
      [p, ok] = await joinRealpath(p, await fs.promises.readlink(newpath));
      if (!ok) return [pyJoin(p, rest), false];
      seen.set(newpath, p);
    }
    return [p, true];
  };
  const [p] = await joinRealpath('', filename);
  return pyNormpath(isAbs(p) ? p : pyJoin(process.cwd(), p));
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** True when `p` (already realpath'd) is strictly inside `rootReal`. */
export function isUnder(p: string, rootReal: string): boolean {
  const root = rootReal === SEP ? '' : rootReal;
  return p.startsWith(root + SEP) && p !== rootReal;
}

/**
 * Resolve a client-supplied recording path to a file inside the recordings root, or
 * explain why not: {path} on success, {status: 403|404} otherwise.
 *
 *   * a relative path is joined to the root; an absolute one is taken as written;
 *   * the realpath (symlinks resolved, '..' applied after them) must stay under the
 *     root's realpath -- '../../etc/passwd' or a symlink out of the tree is a 403;
 *   * a bare basename that is not at the top of the tree is found through the recordings
 *     index (the CDR usually stores only the basename while the file sits in YYYY/MM/DD/),
 *     and the hit must pass the same sandbox check.
 */
export async function resolveRecordingRequest(
  requested: string,
): Promise<{ path: string; status?: undefined } | { path?: undefined; status: 403 | 404 }> {
  const rootDir = await recordingRoot();
  const rootReal = await pyRealpath(rootDir);
  const joined = isAbs(requested) ? requested : pyJoin(rootDir, requested);
  const real = await pyRealpath(joined);
  if (!isUnder(real, rootReal)) return { status: 403 };
  if (await isFile(real)) return { path: real };
  if (!requested.replace(/^\/+|\/+$/g, '').includes(SEP)) {
    const hit = await getRecordingPath(pyBasename(requested));
    if (hit !== null) {
      const candidate = await pyRealpath(hit);
      if (isUnder(candidate, rootReal) && (await isFile(candidate))) return { path: candidate };
    }
  }
  return { status: 404 };
}

// Content types for the formats MixMonitor writes. wav is audio/x-wav, what Python's
// mimetypes answered on Debian; anything unknown is served as audio/wav (the old default).
const AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/x-wav', '.wav49': 'audio/x-wav', '.gsm': 'audio/x-gsm', '.g722': 'audio/G722',
  '.ulaw': 'audio/basic', '.alaw': 'audio/x-alaw-basic', '.sln': 'audio/L16', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus',
};

/** The extension of a basename (os.path.splitext; a leading dot is not one), lower-cased. */
export function fileExt(p: string): string {
  const base = pyBasename(p);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || /^\.+$/.test(base.slice(0, dot + 1))) return '';
  return base.slice(dot).toLowerCase();
}

/** Content-Type for a recording file. */
export function recordingContentType(p: string): string {
  return AUDIO_TYPES[fileExt(p)] || 'audio/wav';
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export async function boolSetting(key: string, fallback = 'false'): Promise<boolean> {
  return ['true', '1', 'yes'].includes(((await dbm.getSetting(key, fallback)) || fallback).trim().toLowerCase());
}

/** A non-negative integer setting, or null when unset / not a number. */
export async function intSettingOrNone(key: string): Promise<number | null> {
  const raw = ((await dbm.getSetting(key, '')) || '').trim();
  return /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : null;
}

// ---------------------------------------------------------------------------
// Policy snapshot (Settings -> Recordings)
// ---------------------------------------------------------------------------

/**
 * Master on/off + format + per-direction toggles + per-extension record state. Policy is
 * opt-OUT and lives in the AstDB (dialplan.getRecordingPolicy): every call records unless
 * its direction or one of its extensions is switched off.
 */
export async function recordingPolicySnapshot(): Promise<Row> {
  const enabled = await boolSetting('RECORDING_ENABLED', env('RECORDING_ENABLED', 'false') || 'false');
  const pol = await getRecordingPolicy();
  const optedOut = new Set<string>(pol.extensions_opted_out);
  let names: Record<string, string> = {};
  let exts: string[] | null = null;
  try {
    names = (await dbm.getExtensionNamesFromDb()) || {};
    exts = await dbm.getExtensionsFromDb();
  } catch (e) {
    log.warning('Could not list extensions for the recording policy: %s', e);
  }
  if (exts === null) exts = Object.keys(names).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    engine: 'opdesk',
    enabled,
    format: (await dbm.getSetting('RECORDING_FORMAT', env('RECORDING_FORMAT', 'wav') || 'wav')) || 'wav',
    mixed_dir: await recordingRoot(),
    single_dir: RECORD_SINGLE_DIR,
    directions: pol.directions,
    // Hooks another dialplan file keeps (OpDesk's recorder then never runs); only asked while
    // recording is on. null = Asterisk could not be asked.
    hook_conflicts: enabled ? await recordingHookConflicts() : [],
    extensions: exts.map((e) => ({
      extension: String(e),
      name: String(e) in names ? names[String(e)] : '',
      recording: !optedOut.has(String(e)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Files: walking, deleting
// ---------------------------------------------------------------------------

/** (path, mtime seconds, size, kind) of one recording file. */
export type WalkedFile = [string, number, number, 'mix' | 'leg'];

/**
 * Every audio file under `rootDir`, top-down, symlinked directories not followed, an
 * unreadable directory skipped (os.walk semantics). Only AUDIO_EXTENSIONS files.
 */
export async function walkAudioFiles(rootDir: string, kind: 'mix' | 'leg'): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const ent of entries) {
      const p = pyJoin(dir, ent.name);
      if (ent.isDirectory()) {
        subdirs.push(p);
        continue;
      }
      if (!AUDIO_EXTENSIONS.has(fileExt(p))) continue;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push([p, st.mtimeMs / 1000, st.size, kind]);
    }
    for (const d of subdirs) await walk(d);
  };
  await walk(rootDir);
  return out;
}

/**
 * The recording trees retention and storage stats cover: the per-speaker legs and the
 * configured root, each file counted once (the root may contain the legs directory).
 */
export async function allRecordingFiles(): Promise<WalkedFile[]> {
  const legs = await walkAudioFiles(RECORD_SINGLE_DIR, 'leg');
  const seen = new Set(legs.map((f) => f[0]));
  const root = await recordingRoot();
  const mixes = (await walkAudioFiles(root, 'mix')).filter((f) => !seen.has(f[0]));
  return [...legs, ...mixes];
}

/** Unlink a file; a file already gone is fine. Falls back to `sudo rm -f` (Asterisk owns the spool). */
export async function deleteFile(p: string): Promise<void> {
  if (shadowMode()) {
    refused(`delete ${p}`);
    return;
  }
  try {
    await fs.promises.unlink(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code !== 'EACCES' && code !== 'EPERM') throw e;
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('sudo', ['-n', 'rm', '-f', '--', p], (err) => {
        if (err && typeof (err as { code?: unknown }).code !== 'number') reject(err);
        else resolve();
      });
    });
  }
}

/**
 * The mixed (CDR-linked) recording for a VAD base: it sits under RECORD_MIX_DIR at the same
 * YYYY/MM/DD/<base> path the single legs use under RECORD_SINGLE_DIR. null when absent.
 */
export async function mixFromBase(base: string): Promise<string | null> {
  if (!base.startsWith(RECORD_SINGLE_DIR + SEP)) return null;
  const rel = base.slice(RECORD_SINGLE_DIR.length);
  for (const ext of ['.wav', '.WAV', '.gsm', '.g722', '.ulaw', '.alaw', '.sln']) {
    const cand = RECORD_MIX_DIR + rel + ext;
    if (await isFile(cand)) return cand;
  }
  return null;
}

/** The -sp1 / -sp2 legs of a mixed recording under RECORD_MIX_DIR, when they exist. */
export async function legsForMix(mixPath: string): Promise<string[]> {
  if (!mixPath.startsWith(RECORD_MIX_DIR + SEP)) return [];
  const rel = mixPath.slice(RECORD_MIX_DIR.length);
  const base = pyBasename(rel);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  const relNoExt = rel.slice(0, rel.length - ext.length);
  const out: string[] = [];
  for (const suffix of ['-sp1', '-sp2']) {
    const leg = RECORD_SINGLE_DIR + relNoExt + suffix + ext;
    if (await isFile(leg)) out.push(leg);
  }
  return out;
}

/**
 * Delete the recording of a call that was never answered: the mixed file and both legs of
 * one [opdesk-record] base. With MixMonitor's `b` flag these hold no audio (a header-only
 * file), so keeping them only costs disk and shows an empty player in Call History. The AMI
 * monitor decides "never answered" from DialEnd and the hangup cause; vad-runner calls this
 * once the files have settled.
 */
export async function deleteRingOnlyRecording(base: string, files: Array<string | null> = []): Promise<number> {
  const targets = new Set<string>(files.filter((f): f is string => Boolean(f)));
  const mix = await mixFromBase(base);
  if (mix) targets.add(mix);
  for (const sp of ['sp1', 'sp2']) {
    for (const ext of ['.wav', '.WAV']) {
      const p = `${base}-${sp}${ext}`;
      if (await isFile(p)) targets.add(p);
    }
  }
  let n = 0;
  for (const f of targets) {
    try {
      await deleteFile(f);
      n += 1;
    } catch (e) {
      log.warning('Could not delete ring-only recording %s: %s', f, e);
    }
  }
  if (n) await invalidateRecordingIndex();
  log.info('Deleted ring-only (unanswered) recording base=%s (%s file(s))', base, n);
  return n;
}

/**
 * Delete one call's local recording (mixed file + any leftover -sp1/-sp2 legs), by the
 * uniqueid of any of its CDR legs. The CDR row is untouched; playback for it 404s afterward.
 * Returns {deleted, deleted_legs}, or {error: 404|500, message}.
 */
export async function deleteRecordingByUniqueid(
  uniqueid: string,
): Promise<{ deleted: string; deleted_legs: string[] } | { error: 404 | 500; message: string }> {
  const recordingfile = await dbm.getCdrRecordingfile(uniqueid);
  if (!recordingfile) return { error: 404, message: 'Recording not found' };
  const p = await getRecordingPath(recordingfile);
  if (!p || !(await isFile(p))) return { error: 404, message: 'Recording file not found on disk' };
  const rootReal = await pyRealpath(await recordingRoot());
  const real = await pyRealpath(p);
  if (!isUnder(real, rootReal) && !isUnder(real, RECORD_MIX_DIR)) {
    return { error: 404, message: 'Recording file not found on disk' };
  }
  const legs = await legsForMix(real);
  try {
    await deleteFile(real);
  } catch (e) {
    log.error('Could not delete recording %s: %s', real, e);
    return { error: 500, message: 'Could not delete recording' };
  }
  const deletedLegs: string[] = [];
  for (const leg of legs) {
    try {
      await deleteFile(leg);
      deletedLegs.push(leg);
    } catch (e) {
      log.warning('Could not delete leftover leg %s: %s', leg, e);
    }
  }
  await invalidateRecordingIndex();
  return { deleted: real, deleted_legs: deletedLegs };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionSummary {
  local_deleted: number;
  /** Always 0: OpDesk keeps no remote copy. Kept so the response shape is stable. */
  remote_deleted: number;
}

/**
 * Age- and size-based cleanup of the local recordings, run once a day by the background
 * loop (the integrator schedules it) and on demand from Settings ("Clean up now").
 *
 *   * age:  delete anything older than RECORDING_LOCAL_RETENTION_DAYS;
 *   * size: once the trees exceed RECORDING_LOCAL_MAX_SIZE_BYTES, delete oldest-first
 *           until back under quota.
 * Neither set -> nothing is deleted. Only audio files are ever removed. Log-and-continue;
 * never throws.
 */
export async function runRecordingRetention(): Promise<RetentionSummary> {
  const summary: RetentionSummary = { local_deleted: 0, remote_deleted: 0 };
  try {
    const days = pyInt(((await dbm.getSetting(LOCAL_RETENTION_DAYS_SETTING, '')) || '').trim()) ?? 0;
    const maxBytes = pyInt(((await dbm.getSetting(LOCAL_MAX_BYTES_SETTING, '')) || '').trim()) ?? 0;
    if (days <= 0 && maxBytes <= 0) return summary;

    const files = await allRecordingFiles();
    let deleted = 0;
    let remaining: WalkedFile[] = [];
    if (days > 0) {
      const cutoff = time() - days * 86400;
      for (const f of files) {
        if (f[1] < cutoff) {
          try {
            await deleteFile(f[0]);
            deleted += 1;
            continue;
          } catch (e) {
            log.warning('Retention: could not delete local file %s: %s', f[0], e);
          }
        }
        remaining.push(f);
      }
    } else {
      remaining = files;
    }

    if (maxBytes > 0) {
      let total = remaining.reduce((acc, f) => acc + f[2], 0);
      if (total > maxBytes) {
        remaining.sort((a, b) => a[1] - b[1]); // oldest first
        for (const [p, , size] of remaining) {
          if (total <= maxBytes) break;
          try {
            await deleteFile(p);
            deleted += 1;
            total -= size;
          } catch (e) {
            log.warning('Retention: could not delete local file %s: %s', p, e);
          }
        }
      }
    }
    if (deleted) {
      log.info('Retention: deleted %s local recording file(s)', deleted);
      await invalidateRecordingIndex();
    }
    summary.local_deleted = deleted;
  } catch (e) {
    log.warning('Local retention sweep failed: %s', e);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Storage statistics
// ---------------------------------------------------------------------------

/** Disk usage of the recording trees and the free space on the recordings filesystem. */
export async function recordingStorageStats(): Promise<Row> {
  const root = await recordingRoot();
  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  try {
    const st = await fs.promises.statfs(root);
    diskFree = st.bavail * st.bsize;
    diskTotal = st.blocks * st.bsize;
  } catch {
    diskFree = diskTotal = null;
  }
  const files = await allRecordingFiles();
  const sum = (kind: 'mix' | 'leg') => files.filter((f) => f[3] === kind).reduce((acc, f) => acc + f[2], 0);
  return {
    total_recordings: await dbm.getRecordingsCountFromDb(),
    local: {
      root_dir: root,
      used_bytes: sum('mix') + sum('leg'),
      mixed_bytes: sum('mix'),
      legs_bytes: sum('leg'),
      file_count: files.length,
      max_bytes: await intSettingOrNone(LOCAL_MAX_BYTES_SETTING),
      disk_free_bytes: diskFree,
      disk_total_bytes: diskTotal,
      retention_days: await intSettingOrNone(LOCAL_RETENTION_DAYS_SETTING),
    },
    remote: { enabled: false, configured: false, used_bytes: null, max_bytes: null, retention_days: null },
  };
}
