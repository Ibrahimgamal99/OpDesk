/**
 * In-process post-call VAD analysis, driven by the AMI monitor.
 *
 * The [opdesk-record] dialplan fires `UserEvent(OpDeskRecording,Recbase: <base>)` at call
 * start; the AMI monitor remembers that base by the channel's Uniqueid and, when the matching
 * Hangup arrives, calls schedule() here. We wait for MixMonitor to finish flushing the files
 * (<base>-sp1.* / <base>-sp2.* and the mixed one), run voice-activity detection on each leg,
 * and upsert the result into the OpDesk DB (call_vad) keyed by Uniqueid.
 *
 * MixMonitor runs with the `b` flag, so the files only contain audio from the moment the
 * called party answers until hangup. A call that was never answered leaves header-only
 * files: the AMI monitor tells us so (deleteUnanswered, from DialEnd / the hangup cause) and
 * they are deleted instead of analysed -- the ring-only cleanup. After a successful store
 * the per-speaker legs are deleted too (VAD_DELETE_SINGLE_LEGS_ENABLED, default on): they
 * exist only for this analysis, and the mixed file is the recording people play.
 *
 * The analysis itself stays in Python (numpy + Silero/onnxruntime, webrtcvad as fallback):
 * vad/call_vad_analysis.py runs as one long-lived `--serve` worker that loads the model once
 * and answers one JSON line per call. It runs under VAD_PYTHON, else the installer's venv
 * (backend/vad/.venv/bin/python), else python3 -- never the PBX's system Python packages.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { BACKEND_DIR, env } from '../core/config';
import { getLogger } from '../core/logger';
import { createTask, pyRound, sleep, time } from '../core/py';
import * as dbm from '../db/db-manager';
import { boolSetting, deleteFile, deleteRingOnlyRecording, isFile, mixFromBase, VAD_DELETE_LEGS_SETTING } from './recording';

const log = getLogger('services.vad_runner');

export const SETTLE_TIMEOUT_S = 30.0; // max wait for the WAV legs to finish flushing after hangup
export const POLL_INTERVAL_S = 0.5;
// The analysis had no timeout in-process; the worker gets one so a wedged interpreter cannot
// hold the queue forever. Silero runs at ~1-2% of real time.
export const VAD_TIMEOUT_S = 600;

export const VAD_SCRIPT = path.join(BACKEND_DIR, 'vad', 'call_vad_analysis.py');
export const VAD_VENV_PYTHON = path.join(BACKEND_DIR, 'vad', '.venv', 'bin', 'python');

/** The interpreter the worker runs under: VAD_PYTHON, else the vad venv, else python3. */
export function vadPython(): string {
  const configured = env('VAD_PYTHON', '').trim();
  if (configured) return configured;
  try {
    fs.accessSync(VAD_VENV_PYTHON, fs.constants.X_OK);
    return VAD_VENV_PYTHON;
  } catch {
    return 'python3';
  }
}

/** At most `slots` analyses at once (Python's 4-worker executor). */
export class Semaphore {
  private waiters: Array<() => void> = [];

  constructor(private slots: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.slots > 0) this.slots -= 1;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.slots += 1;
    }
  }
}

export const vadExecutor = new Semaphore(4);

/** One VAD segment, in seconds. */
export interface Segment {
  start: number;
  end: number;
}

/** call_vad_analysis.analyze_pair()'s result. A leg is a segment list or {error}. */
export interface VadResult {
  base: string;
  sp1_file: string | null;
  sp2_file: string | null;
  duration: number | null;
  speakers: Record<string, Segment[] | { error: string }>;
}

export interface VadOutcome {
  vad: VadResult;
  sp1: string | null;
  sp2: string | null;
}

/** Total time both legs speak simultaneously (interval intersection). */
export function overlapSeconds(sp1Segs: Segment[] | null, sp2Segs: Segment[] | null): number {
  if (!sp1Segs || !sp1Segs.length || !sp2Segs || !sp2Segs.length) return 0.0;
  const byStartEnd = (x: [number, number], y: [number, number]) => x[0] - y[0] || x[1] - y[1];
  const a = sp1Segs.map((s): [number, number] => [s.start, s.end]).sort(byStartEnd);
  const b = sp2Segs.map((s): [number, number] => [s.start, s.end]).sort(byStartEnd);
  let i = 0;
  let j = 0;
  let total = 0.0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) total += hi - lo;
    if (a[i][1] < b[j][1]) i += 1;
    else j += 1;
  }
  return pyRound(total, 3);
}

/** Total talk time of one leg's segments. */
export function talk(segs: Array<Partial<Segment>> | null): number {
  if (!segs || !segs.length) return 0.0;
  let sum = 0;
  for (const s of segs) sum += Math.max(0.0, (s.end ?? 0) - (s.start ?? 0));
  return pyRound(sum, 3);
}

/** call_vad_analysis.pair_from_base: the -sp1 / -sp2 legs of a base, .wav before .WAV. */
export async function pairFromBase(base: string): Promise<[string | null, string | null]> {
  const find = async (sp: string): Promise<string | null> => {
    for (const ext of ['.wav', '.WAV']) {
      const p = `${base}-${sp}${ext}`;
      if (await isFile(p)) return p;
    }
    return null;
  };
  return [await find('sp1'), await find('sp2')];
}

async function sizes(files: string[]): Promise<number[] | null> {
  try {
    const out: number[] = [];
    for (const f of files) out.push((await fs.promises.stat(f)).size);
    return out;
  } catch {
    return null;
  }
}

function sameSizes(a: number[] | null, b: number[] | null): boolean {
  return a !== null && b !== null && a.length === b.length && a.every((v, k) => v === b[k]);
}

/**
 * The long-lived `<python> vad/call_vad_analysis.py --serve` process. Spawned on first use,
 * fed one request at a time (a timeout then only costs that call: the worker is killed and
 * the next request starts a fresh one), and respawned whenever it exits.
 */
export class VadWorker {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: {
    id: number;
    proc: ChildProcess;
    resolve: (r: VadResult) => void;
    reject: (e: Error) => void;
  } | null = null;

  /** call_vad_analysis.analyze_pair(sp1, sp2); queued behind any analysis already running. */
  analyze(sp1: string | null, sp2: string | null): Promise<VadResult> {
    const run = this.tail.then(() => this.send(sp1, sp2));
    this.tail = run.catch(() => undefined);
    return run;
  }

  stop(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
  }

  private start(): ChildProcess {
    const python = vadPython();
    const proc = spawn(python, [VAD_SCRIPT, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: proc.stderr! }).on('line', (line) => log.info('VAD worker: %s', line));
    const gone = (why: string) => {
      if (this.proc === proc) this.proc = null;
      // A worker stopped earlier can exit after its successor took a request: only fail ours.
      if (this.pending?.proc === proc) this.fail(new Error(`VAD worker ${why}`));
    };
    proc.on('error', (e) => gone(`failed: ${e.message}`));
    proc.stdin!.on('error', (e) => log.warning('VAD worker stdin: %s', e.message));
    proc.on('exit', (code, signal) => gone(`exited (${signal ?? code})`));
    log.info('VAD worker started (%s, pid %s)', python, proc.pid);
    return proc;
  }

  private send(sp1: string | null, sp2: string | null): Promise<VadResult> {
    if (!this.proc) this.proc = this.start();
    const proc = this.proc;
    const id = this.nextId++;
    return new Promise<VadResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`VAD analysis timed out after ${VAD_TIMEOUT_S}s`));
        if (this.proc === proc) this.stop();
      }, VAD_TIMEOUT_S * 1000);
      this.pending = {
        id,
        proc,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      proc.stdin!.write(JSON.stringify({ id, sp1, sp2 }) + '\n');
    });
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: VadResult; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      log.warning('VAD worker printed a non-JSON line: %s', line.slice(0, 200));
      return;
    }
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    this.pending = null;
    if (msg.error !== undefined || !msg.result) p.reject(new Error(msg.error || 'VAD worker sent no result'));
    else p.resolve(msg.result);
  }

  private fail(e: Error): void {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(e);
  }
}

export const vadWorker = new VadWorker();

/** analyze_pair(sp1, sp2) on the shared worker. Rejects when the worker fails, times out, or dies. */
export function analyzePair(sp1: string | null, sp2: string | null): Promise<VadResult> {
  return vadWorker.analyze(sp1, sp2);
}

/**
 * Wait for the recording files to settle, delete them when the call was never answered,
 * else run VAD. Returns {vad, sp1, sp2}, or null (deleted, or nothing recorded).
 */
export async function waitAndAnalyze(base: string, deleteUnanswered = false): Promise<VadOutcome | null> {
  const mix = await mixFromBase(base);
  // Poll until the legs (and mixed file) are present and flushed. A stable 44-byte file is a
  // settled header-only recording (no media ever flowed): treat it as flushed instead of
  // burning the whole timeout on it.
  const deadline = time() + SETTLE_TIMEOUT_S;
  let last: number[] | null = null;
  let sp1: string | null = null;
  let sp2: string | null = null;
  let settled = false;
  while (time() < deadline) {
    [sp1, sp2] = await pairFromBase(base);
    const present = [mix ?? (await mixFromBase(base)), sp1, sp2].filter((f): f is string => Boolean(f));
    const s = present.length ? await sizes(present) : null;
    if (s && s.length && s.every((v) => v >= 44) && sameSizes(s, last)) {
      settled = true;
      break;
    }
    last = s;
    await sleep(POLL_INTERVAL_S);
  }
  if (!settled) [sp1, sp2] = await pairFromBase(base);

  if (deleteUnanswered) {
    await deleteRingOnlyRecording(base, [mix, sp1, sp2]);
    return null;
  }
  if (sp1 || sp2) return { vad: await analyzePair(sp1, sp2), sp1, sp2 };
  return null;
}

/**
 * json.dumps(speakers) byte for byte: Python's ', ' / ': ' separators, ensure_ascii, and
 * floats written as floats -- call_vad.segments keeps the bytes the Python server wrote.
 */
export function pyJsonDumpsFloats(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return Number.isInteger(v) && Math.abs(v) < 1e16 ? `${v}.0` : String(v);
  }
  if (typeof v === 'string') {
    return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  if (Array.isArray(v)) return '[' + v.map(pyJsonDumpsFloats).join(', ') + ']';
  if (typeof v === 'object') {
    return (
      '{' +
      Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${pyJsonDumpsFloats(k)}: ${pyJsonDumpsFloats(x)}`)
        .join(', ') +
      '}'
    );
  }
  return pyJsonDumpsFloats(String(v));
}

/**
 * Wait for the recording legs, delete ring-only ones, run VAD, store the result, and delete
 * the single legs once stored (setting VAD_DELETE_SINGLE_LEGS_ENABLED, default on).
 */
export async function analyzeAndStore(base: string, uniqueid: string, deleteUnanswered = false): Promise<void> {
  if (!base || !uniqueid) return;
  let outcome: VadOutcome | null;
  try {
    outcome = await vadExecutor.run(() => waitAndAnalyze(base, deleteUnanswered));
  } catch (e) {
    log.warning('VAD analyze failed (%s): %s', uniqueid, e);
    return;
  }
  if (deleteUnanswered) return; // recording removed; nothing to analyse or store
  if (!outcome) {
    log.info('VAD: no recording legs found for %s (base=%s)', uniqueid, base);
    return;
  }

  const result: Partial<VadResult> = outcome.vad || {};
  const speakers: Record<string, unknown> = result.speakers || {};
  const sp1 = Array.isArray(speakers.sp1) ? (speakers.sp1 as Segment[]) : [];
  const sp2 = Array.isArray(speakers.sp2) ? (speakers.sp2 as Segment[]) : [];

  const stored = await dbm.upsertCallVad(uniqueid, {
    base: Array.from(String(result.base || '')).slice(0, 255).join('') || null,
    duration: result.duration ?? null,
    sp1TalkSeconds: talk(sp1),
    sp2TalkSeconds: talk(sp2),
    overlapSeconds: overlapSeconds(sp1, sp2),
    sp1Segments: sp1.length,
    sp2Segments: sp2.length,
    // ensure_ascii output is ASCII, so slicing UTF-16 units is slicing characters.
    segmentsJson: pyJsonDumpsFloats(speakers).slice(0, 16_000_000),
  });
  if (!stored) {
    log.warning('VAD store failed (%s); keeping the legs', uniqueid);
    return; // never delete what we could not confirm was analysed
  }
  log.info('VAD stored for %s: sp1=%dseg sp2=%dseg dur=%s', uniqueid, sp1.length, sp2.length, result.duration ?? null);

  let deleteLegs = true;
  try {
    deleteLegs = await boolSetting(VAD_DELETE_LEGS_SETTING, 'true');
  } catch {
    deleteLegs = true;
  }
  if (!deleteLegs) return;
  for (const f of [outcome.sp1, outcome.sp2]) {
    if (!f) continue;
    try {
      await deleteFile(f);
    } catch (e) {
      log.warning('Could not delete VAD leg %s: %s', f, e);
    }
  }
}

/**
 * Fire-and-forget the analysis. `deleteUnanswered`: the AMI monitor saw no answer (no
 * DialEnd ANSWER and a non-answer DialStatus, or a busy/unreachable hangup cause), so the
 * recording is ring-only and is deleted instead of analysed.
 */
export function schedule(base: string, uniqueid: string, deleteUnanswered = false): void {
  createTask(analyzeAndStore(base, uniqueid, deleteUnanswered), (e) => log.warning('VAD task failed (%s): %s', uniqueid, e));
}

/** Stop the worker (shutdown hook). */
export function stopVadWorker(): void {
  vadWorker.stop();
}
