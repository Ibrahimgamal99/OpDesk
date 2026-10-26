/**
 * Asterisk configuration OpDesk writes: the QoS hangup handler, the mobile pre-dial wake
 * hook, call recording (MixMonitor from the FreePBX/IssabelPBX predial hooks) with its
 * per-direction / per-extension policy, and the PJSIP TLS transport. Plus the reload
 * commands each PBX flavour needs.
 *
 * Port of backend/dialplan.py. Every file and block OpDesk generates carries the same
 * markers the Python wrote (the "; OpDesk ... auto-generated" headers, the
 * "; --- OpDesk SIP TLS BEGIN/END ---" pair, the `#include` lines), so a box switched over
 * from the Python server has its existing config recognised and replaced, never duplicated.
 *
 * Every generator is a pure render*() function returning the text, so the output can be
 * checked without touching /etc/asterisk (test/dialplan.spec.ts); the write*() functions
 * put that text in place with `sudo cp`, the way the Python did, at runtime only.
 *
 * PBX flavours (env PBX, or the PBX setting the caller passes):
 *   FreePBX   predial hooks are Gosub'd (end in Return()); config applied by `fwconsole reload`;
 *             TLS transport overrides go to pjsip.transports_custom.conf.
 *   Issabel   IssabelPBX (a FreePBX 2.11 fork) still runs the predial hooks with Macro(), so
 *             they end in MacroExit(); config applied by `amportal a r` (falling back to
 *             retrieve_conf + core reload); pjsip.conf includes pjsip_custom_post.conf last,
 *             which is where the TLS transport goes.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomInt } from 'crypto';

import { env } from '../core/config';
import { getLogger, pyStr } from '../core/logger';
import { pyFloat, truthy } from '../core/py';
import * as dbm from '../db/db-manager';
import { commandAllowed, refused } from '../core/shadow';

const log = getLogger('services.dialplan');

// ---------------------------------------------------------------------------
// subprocess / filesystem helpers (Python used subprocess.run, tempfile and open)
// ---------------------------------------------------------------------------

/** subprocess.CompletedProcess: what subprocess.run(..., capture_output=True) returned. */
export interface CompletedProcess {
  returncode: number;
  stdout: string;
  stderr: string;
}

/** subprocess.TimeoutExpired: the command outlived its `timeout` and was killed. */
export class SubprocessTimeoutError extends Error {
  constructor(
    readonly cmd: string[],
    readonly timeout: number,
  ) {
    super(`Command '${JSON.stringify(cmd)}' timed out after ${timeout} seconds`);
    this.name = 'TimeoutExpired';
  }
}

// `database show` on a PBX with hundreds of extensions is far past execFile's 1 MB default.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * subprocess.run(argv, capture_output=True[, input=...][, timeout=...]): runs argv with
 * execFile (never a shell), resolves with the exit status and, like Python, does not throw
 * on a non-zero exit. Throws SubprocessTimeoutError when `timeout` (seconds) runs out and
 * the spawn error (ENOENT = FileNotFoundError) when the program cannot be started.
 */
export function subprocessRun(
  argv: string[],
  opts: { timeout?: number | null; input?: string | null } = {},
): Promise<CompletedProcess> {
  const timeout = opts.timeout ?? null;
  if (!commandAllowed(argv)) {
    refused(argv.join(' '));
    return Promise.resolve({ returncode: 1, stdout: '', stderr: 'refused in shadow mode' });
  }
  return new Promise<CompletedProcess>((resolve, reject) => {
    const child = cp.execFile(
      argv[0],
      argv.slice(1),
      { encoding: 'buffer', timeout: timeout ? timeout * 1000 : 0, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout, stderr) => {
        const out = stdout ? Buffer.from(stdout).toString('utf8') : '';
        const errText = stderr ? Buffer.from(stderr).toString('utf8') : '';
        if (!err) {
          resolve({ returncode: 0, stdout: out, stderr: errText });
          return;
        }
        const e = err as cp.ExecFileException;
        if (typeof e.code === 'number') {
          resolve({ returncode: e.code, stdout: out, stderr: errText });
        } else if (e.killed && timeout) {
          reject(new SubprocessTimeoutError(argv, timeout));
        } else if (e.signal) {
          resolve({ returncode: -(os.constants.signals[e.signal] ?? 1), stdout: out, stderr: errText });
        } else {
          reject(err);
        }
      },
    );
    if (child && child.stdin) {
      child.stdin.on('error', () => undefined);
      if (opts.input !== undefined && opts.input !== null) child.stdin.end(opts.input);
      else child.stdin.end();
    }
  });
}

const TEMP_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_';

/** tempfile.NamedTemporaryFile(delete=False, suffix='.conf'): a new 0600 temp file with `content`. */
export async function namedTemporaryFile(content: string, suffix = '.conf'): Promise<string> {
  for (;;) {
    let name = 'tmp';
    for (let i = 0; i < 8; i++) name += TEMP_CHARS[randomInt(TEMP_CHARS.length)];
    const p = path.join(os.tmpdir(), name + suffix);
    try {
      await fs.promises.writeFile(p, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** os.path.exists */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** os.path.isfile */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** open(p).read() in text mode: \r\n and \r read as \n. */
export async function readText(p: string): Promise<string> {
  return (await fs.promises.readFile(p, 'utf8')).replace(/\r\n?/g, '\n');
}

/** str.splitlines([keepends]) with Python's line boundaries. */
export function splitlines(s: string, keepends = false): string[] {
  const out: string[] = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(s.slice(last, keepends ? m.index + m[0].length : m.index));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** str.replace(old, new): every occurrence, with no `$&`-style patterns in `new`. */
function pyReplace(s: string, oldText: string, newText: string): string {
  return s.split(oldText).join(newText);
}

const basename = (p: string): string => path.posix.basename(p);

/**
 * Put `content` at `filePath` the way every Python writer did: a temp file, `sudo cp` over
 * the target, `sudo chmod 644`. /etc/asterisk belongs to the asterisk user, and the backend
 * runs as another one with a sudoers rule for exactly these commands.
 */
export async function sudoWrite(filePath: string, content: string): Promise<boolean> {
  let tmpPath: string | null = null;
  try {
    tmpPath = await namedTemporaryFile(content);
    const result = await subprocessRun(['sudo', 'cp', tmpPath, filePath]);
    await subprocessRun(['sudo', 'chmod', '644', filePath]);
    if (result.returncode !== 0) {
      log.error('Failed to write %s: %s', filePath, result.stderr);
      return false;
    }
    return true;
  } catch (e) {
    log.error('Error writing %s: %s', filePath, e);
    return false;
  } finally {
    if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Paths and PBX flavour
// ---------------------------------------------------------------------------

export const EXTENSIONS_CUSTOM_CONF = '/etc/asterisk/extensions_custom.conf';
export const EXTENSIONS_OPDESK_CONF = '/etc/asterisk/extensions_opdesk.conf';
export const EXTENSIONS_MOBILE_WAKE_CONF = '/etc/asterisk/extensions_mobile_wake.conf';
export const EXTENSIONS_RECORD_CONF = '/etc/asterisk/extensions_opdesk_record.conf';

// Where MixMonitor writes call recordings.
//   - The mixed file goes to the FreePBX/Issabel default monitor dir, so it lands where the
//     CDR(recordingfile) field points (CDR reports find it).
//   - The two single-leg files (caller=sp1, callee=sp2) go to a sibling folder.
// Both are date-partitioned YYYY/MM/DD exactly like FreePBX's native recorder.
export const RECORD_MIX_DIR = '/var/spool/asterisk/monitor';
export const RECORD_SINGLE_DIR = '/var/spool/asterisk/single';

// FreePBX: included INSIDE pjsip.transports.conf BEFORE the auto-generated [0.0.0.0-tls]
// section. PJSIP uses first-wins for duplicate section names, so this file's definition wins
// over the auto-generated one. pjsip.transports_custom_post.conf is included AFTER and
// therefore loses -- do NOT use it for transport overrides.
export const PJSIP_TRANSPORTS_CUSTOM = '/etc/asterisk/pjsip.transports_custom.conf';
// Issabel: pjsip.conf includes this last, after [global].
export const PJSIP_CUSTOM_POST = '/etc/asterisk/pjsip_custom_post.conf';

export type PbxKind = 'freepbx' | 'issabel';

/** 'issabel' when the PBX setting (or env PBX) says Issabel, else 'freepbx'. */
export function pbxKind(pbx: string | null | undefined = null): PbxKind {
  const v = (pbx || env('PBX', '') || '').trim().toLowerCase();
  return v === 'issabel' ? 'issabel' : 'freepbx';
}

/** The command an admin would run to apply PBX config by hand, for messages and logs. */
export function pbxApplyCommand(pbx: string | null | undefined = null): string {
  return pbxKind(pbx) === 'issabel' ? 'amportal a r' : 'fwconsole reload';
}

/**
 * How a predial hook context must end. FreePBX 13+ Gosubs the hooks and its stubs are
 * `Return()`; IssabelPBX invokes them with Macro() (core_functions: ext_macro(
 * 'dialout-trunk-predial-hook')), where Return() would find an empty Gosub stack and hang
 * the call up -- so the macro form exits with MacroExit().
 */
export function hookExit(pbx: string | null | undefined = null): string {
  return pbxKind(pbx) === 'issabel' ? 'MacroExit()' : 'Return()';
}

// ---------------------------------------------------------------------------
// extensions_custom.conf includes
// ---------------------------------------------------------------------------

/**
 * `existing` with a `#include <includeBasename>` line appended, or null when it already
 * includes the file (as a relative or an absolute include).
 */
export function withInclude(existing: string, includeBasename: string, absolute: string | null = null): string | null {
  const lines = [`#include ${includeBasename}`];
  if (absolute) lines.push(`#include ${absolute}`);
  if (lines.some((l) => existing.includes(l))) return null;
  let out = existing;
  if (out && !out.endsWith('\n')) out += '\n';
  return out + `#include ${includeBasename}\n`;
}

/** Ensure extensions_custom.conf includes `confPath`. False when the write failed. */
export async function ensureInclude(confPath: string): Promise<boolean> {
  let existing = '';
  if (await pathExists(EXTENSIONS_CUSTOM_CONF)) existing = await readText(EXTENSIONS_CUSTOM_CONF);
  const next = withInclude(existing, basename(confPath), confPath);
  if (next === null) {
    log.info('%s already includes %s', EXTENSIONS_CUSTOM_CONF, confPath);
    return true;
  }
  if (!(await sudoWrite(EXTENSIONS_CUSTOM_CONF, next))) return false;
  log.info('Ensured %s includes %s', EXTENSIONS_CUSTOM_CONF, basename(confPath));
  return true;
}

// ---------------------------------------------------------------------------
// Reloads
// ---------------------------------------------------------------------------

/** Reload the Asterisk dialplan ('dialplan reload'): enough for every extensions_*.conf change. */
export async function reloadAsteriskDialplan(): Promise<boolean> {
  log.info('Reloading Asterisk dialplan...');
  try {
    const result = await subprocessRun(['sudo', 'asterisk', '-rx', 'dialplan reload'], { timeout: 10 });
    if (result.returncode === 0) {
      log.info('Successfully reloaded Asterisk dialplan');
      return true;
    }
    log.error('Failed to reload dialplan: %s', result.stderr);
    return false;
  } catch (e) {
    if (e instanceof SubprocessTimeoutError) log.error('Timeout while reloading Asterisk dialplan');
    else log.error('Error reloading dialplan: %s', e);
    return false;
  }
}

/** The amportal binary IssabelPBX installs, or null. */
async function findAmportal(): Promise<string | null> {
  for (const p of ['/usr/sbin/amportal', '/usr/local/sbin/amportal']) {
    if (await isFile(p)) return p;
  }
  return null;
}

/**
 * Apply PBX configuration (SIP/WebRTC changes made in the PBX database).
 *   Issabel: `amportal a r` (the GUI's "Apply Config": module_admin reload, which runs
 *            retrieve_conf and reloads Asterisk); without amportal,
 *            `retrieve_conf && asterisk -rx "core reload"`.
 *   FreePBX: `fwconsole reload`.
 */
export async function reloadAsteriskSip(pbxType: string | null = null): Promise<boolean> {
  const kind = pbxKind(pbxType);
  try {
    let result: CompletedProcess;
    if (kind === 'issabel') {
      const amportal = await findAmportal();
      if (amportal) {
        log.info("PBX=Issabel detected; running 'amportal a r'...");
        result = await subprocessRun(['sudo', amportal, 'a', 'r'], { timeout: 120 });
      } else {
        log.info('PBX=Issabel detected; running \'retrieve_conf\' and \'asterisk -rx "core reload"\'...');
        // A fixed command line: the shell is part of the command, nothing is built from input.
        const cmd = '/var/lib/asterisk/bin/retrieve_conf && asterisk -rx "core reload"';
        result = await subprocessRun(['sudo', 'bash', '-c', cmd], { timeout: 60 });
      }
    } else {
      log.info("Running 'fwconsole reload' to apply SIP/WebRTC changes...");
      result = await subprocessRun(['sudo', 'fwconsole', 'reload'], { timeout: 120 });
    }
    if (result.returncode === 0) {
      log.info('Successfully reloaded Asterisk SIP / config');
      return true;
    }
    const msg = (result.stderr || '').trim() || (result.stdout || '').trim() || 'no output';
    log.warning('SIP/config reload command failed (PBX=%s): %s', kind, msg);
    return false;
  } catch (e) {
    if (e instanceof SubprocessTimeoutError) log.warning('Timeout while reloading SIP/config (PBX=%s)', kind);
    else if ((e as NodeJS.ErrnoException).code === 'ENOENT') log.warning('Reload command not found (PBX=%s): %s', kind, e);
    else log.warning('Error reloading SIP/config (PBX=%s): %s', kind, e);
    return false;
  }
}

/**
 * Enable/disable Asterisk SIP message tracing via the CLI: the PJSIP logger, and chan_sip's
 * debug best-effort for legacy stacks (a no-op if chan_sip is not loaded). The System Logs
 * SIP tailer reads what Asterisk logs.
 */
export async function setPjsipLogger(enabled: boolean): Promise<boolean> {
  const state = enabled ? 'on' : 'off';
  let ok = false;
  for (const cmd of [`pjsip set logger ${state}`, `sip set debug ${state}`]) {
    try {
      const result = await subprocessRun(['sudo', 'asterisk', '-rx', cmd], { timeout: 10 });
      if (result.returncode === 0) ok = true;
      else log.debug("'%s' returned %s: %s", cmd, result.returncode, result.stderr.trim());
    } catch (e) {
      if (e instanceof SubprocessTimeoutError) log.warning("Timeout running '%s'", cmd);
      else log.warning("Error running '%s': %s", cmd, e);
    }
  }
  if (ok) log.info('SIP tracing %s', enabled ? 'enabled' : 'disabled');
  return ok;
}

// ===========================================================================
// QoS
// ===========================================================================

/** extensions_opdesk.conf with QoS on: a hangup handler that copies RTP QoS into CDR(userfield). */
export function renderQosConf(): string {
  return `[from-internal-custom]
exten => _.,1,Set(CHANNEL(hangup_handler_push)=qos-handler,s,1)

[from-pstn-custom]
exten => _.,1,Set(CHANNEL(hangup_handler_push)=qos-handler,s,1)

; 2. The Logic remains the same, but now it's guaranteed to run
[qos-handler]
exten => s,1,NoOp(-- QoS Handler Start --)
 same => n,Set(QOS_SRC=\${IF($["\${RTPAUDIOQOSBRIDGED}"!=""]?\${RTPAUDIOQOSBRIDGED}:\${RTPAUDIOQOS})})
 same => n,GotoIf($["\${QOS_SRC}" != ""]?save)
 same => n,Set(QOS_SRC=\${DB(qos/\${CHANNEL(linkedid)}/data)})

 same => n(save),GotoIf($["\${QOS_SRC}" = ""]?end)
 same => n,Set(QOS_CALLER=\${IF($["\${DB(qos/\${CHANNEL(linkedid)}/caller)}"!=""]?\${DB(qos/\${CHANNEL(linkedid)}/caller)}:\${CALLERID(num)})})
 same => n,Set(CDR(userfield)=QoS:\${QOS_SRC},Caller:\${QOS_CALLER})
 same => n,NoOp(Saved QoS to CDR: \${CDR(userfield)})
 same => n,DBdeltree(qos/\${CHANNEL(linkedid)})
 same => n(end),NoOp(QoS Handler Finished)
 same => n,Return()
`;
}

/** extensions_opdesk.conf with QoS off (the file and its #include stay). */
export const QOS_OFF_CONTENT = '; QoS disabled – OpDesk dialplan cleared by OpDesk backend\n';

/** Write the QoS dialplan to extensions_opdesk.conf and make sure extensions_custom.conf includes it. */
export async function writeQosConf(): Promise<boolean> {
  log.info('Writing QoS dialplan to %s', EXTENSIONS_OPDESK_CONF);
  try {
    if (!(await sudoWrite(EXTENSIONS_OPDESK_CONF, renderQosConf()))) return false;
    log.info('Successfully wrote QoS custom dialplan to %s', EXTENSIONS_OPDESK_CONF);
    return await ensureInclude(EXTENSIONS_OPDESK_CONF);
  } catch (e) {
    log.error('Error writing QoS configuration files: %s', e);
    return false;
  }
}

/** Clear the QoS contexts from extensions_opdesk.conf, keeping the file and its #include. */
export async function removeQosConf(): Promise<boolean> {
  log.info('Clearing QoS custom dialplan from %s', EXTENSIONS_OPDESK_CONF);
  try {
    if (!(await pathExists(EXTENSIONS_OPDESK_CONF))) {
      log.info('%s does not exist. Nothing to clear.', EXTENSIONS_OPDESK_CONF);
      return true;
    }
    if (!(await sudoWrite(EXTENSIONS_OPDESK_CONF, QOS_OFF_CONTENT))) return false;
    log.info('Successfully cleared QoS dialplan from %s', EXTENSIONS_OPDESK_CONF);
    return true;
  } catch (e) {
    log.error('Error clearing QoS configuration file: %s', e);
    return false;
  }
}

/** Enable QoS: write the dialplan, reload it. */
export async function enableQos(): Promise<boolean> {
  log.info('Enabling QoS configuration...');
  if (!(await writeQosConf())) {
    log.error('Failed to write QoS configuration. Aborting.');
    return false;
  }
  if (!(await reloadAsteriskDialplan())) {
    log.error('Failed to reload dialplan. Configuration may not be active.');
    return false;
  }
  log.info('QoS configuration enabled successfully!');
  return true;
}

/** Disable QoS: clear the dialplan, reload it. */
export async function disableQos(): Promise<boolean> {
  log.info('Disabling QoS configuration...');
  if (!(await removeQosConf())) log.error('Failed to clear QoS configuration. Continuing...');
  if (!(await reloadAsteriskDialplan())) {
    log.error('Failed to reload dialplan. Configuration may still be active.');
    return false;
  }
  log.info('QoS configuration disabled successfully!');
  return true;
}

// ===========================================================================
// Mobile wake (RFC 8599 "hold the INVITE until the device re-registers")
// ===========================================================================

export const MOBILE_WAKE_WAIT_DEFAULT = 10;
export const MOBILE_WAKE_WAIT_MIN = 8;
export const MOBILE_WAKE_WAIT_MAX = 30;
export const MOBILE_WAKE_SETTLE_DEFAULT = 3;
export const MOBILE_WAKE_SETTLE_MIN = 0;
export const MOBILE_WAKE_SETTLE_MAX = 10;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/**
 * A Mobile Wake number from the DB (source of truth, edited in Settings), else .env, else
 * `fallback`; clamped to [lo, hi].
 */
export async function mobileWakeSetting(key: string, envName: string, fallback: number, lo: number, hi: number): Promise<number> {
  let value: string | null = null;
  try {
    value = await dbm.getSetting(key, null);
  } catch {
    value = null;
  }
  if (value === null || value === undefined || value === '') value = env(envName, String(fallback));
  const f = pyFloat(value);
  const n = f === null || !Number.isFinite(f) ? fallback : Math.trunc(f);
  return clamp(n, lo, hi);
}

/**
 * extensions_mobile_wake.conf: the automatic "wake before dial" hook in
 * [from-internal-custom].
 *
 * Why here and not a predial hook: when a mobile app is killed/backgrounded its SIP
 * registration expires, so PJSIP_DIAL_CONTACTS() returns empty and macro-dial-one bails to
 * "nodial" with CHANUNAVAIL *before* it reaches the predial hook -- the phone is never
 * dialled and no DialBegin fires. The wake must happen before contact resolution.
 * [from-internal-custom] is included first in [from-internal] and re-entered by the
 * Local/<ext>@from-internal channels ring groups, queues and follow-me use, so one hook
 * covers internal calls and most inbound paths with no per-extension configuration.
 *
 * Per call the hook: falls through for anything that is not a local extension; CURLs the
 * backend wake endpoint (answers "1" only when a push went out); holds the call, polling
 * .../ready every 0.5 s for up to `holdSeconds`, until the app has re-registered; waits
 * `settleSeconds`; then hands the call back to the full stack via
 * Goto(from-internal-additional,${EXTEN},1). If the hold runs out, or the caller hangs up
 * meanwhile (hangup handler), it CURLs .../cancel so the phone stops ringing.
 */
export function renderMobileWakeConf(backendPort: number, holdSeconds: number, settleSeconds: number): string {
  const hold = clamp(Math.trunc(holdSeconds), MOBILE_WAKE_WAIT_MIN, MOBILE_WAKE_WAIT_MAX);
  const settle = clamp(Math.trunc(settleSeconds), MOBILE_WAKE_SETTLE_MIN, MOBILE_WAKE_SETTLE_MAX);
  const base = `http://127.0.0.1:${backendPort}/api/internal/mobile-wake`;
  const uid = '${URIENCODE(${OPDESKWAKE_UID})}';
  const settleLine = settle ? ` same => n,Wait(${settle})\n` : '';

  // The wake/continue body is identical for 3- and 4-digit extensions; emit it per pattern.
  const hookLines = (pattern: string): string =>
    `exten => ${pattern},1,NoOp(OpDesk mobile wake check for \${EXTEN})
 same => n,ExecIf($[\${DIALPLAN_EXISTS(qos-handler,s,1)}]?Set(CHANNEL(hangup_handler_push)=qos-handler,s,1))
 same => n,GotoIf($["\${DB(AMPUSER/\${EXTEN}/device)}"=""]?passthru)
 same => n,Set(CURLOPT(conntimeout)=2)
 same => n,Set(CURLOPT(httptimeout)=4)
 same => n,Set(OPDESKWAKE_EXT=\${EXTEN})
 same => n,Set(OPDESKWAKE_UID=\${UNIQUEID})
 same => n,Set(OPDESKWAKE=\${CURL(${base}/\${EXTEN}?uid=${uid}&caller=\${URIENCODE(\${CALLERID(num)})}&name=\${URIENCODE(\${CALLERID(name)})})})
 same => n,GotoIf($["\${OPDESKWAKE}"!="1"]?passthru)
 same => n,Set(OPDESKWAKE_PENDING=1)
 same => n,Set(CHANNEL(hangup_handler_push)=opdesk-mobile-wake-hangup,s,1)
 same => n,Set(WAITLEFT=${hold})
 same => n(poll),GotoIf($[\${WAITLEFT}<=0]?timeout)
 same => n,Wait(0.5)
 same => n,Set(WAITLEFT=$[\${WAITLEFT}-0.5])
 same => n,GotoIf($["\${CURL(${base}/\${EXTEN}/ready?uid=${uid})}"!="1"]?poll)
${settleLine} same => n,Set(OPDESKWAKE_PENDING=0)
 same => n,Set(OPDESKWAKE=\${CURL(${base}/\${EXTEN}/done?uid=${uid})})
 same => n,Goto(passthru)
 same => n(timeout),Set(OPDESKWAKE_PENDING=0)
 same => n,Set(OPDESKWAKE=\${CURL(${base}/\${EXTEN}/cancel?uid=${uid})})
 same => n(passthru),Goto(from-internal-additional,\${EXTEN},1)
`;

  return `; OpDesk mobile wake dialplan — auto-generated. Do not edit manually.
;
; RFC 8599 for Asterisk: pushes a mobile softphone BEFORE FreePBX tries to resolve its
; SIP contact, holds the call until the app has re-registered, then lets it ring. Runs
; automatically for every internal call and for ring-group/queue/follow-me legs (which
; re-enter from-internal via Local channels). No per-extension configuration required.
;
; Hold ${hold}s, settle ${settle}s: Settings -> Mobile Wake.
;
[from-internal-custom]
${hookLines('_XXX')}
${hookLines('_XXXX')}
[opdesk-mobile-wake-hangup]
exten => s,1,GotoIf($["\${OPDESKWAKE_PENDING}"!="1"]?done)
 same => n,Set(OPDESKWAKE=\${CURL(${base}/\${OPDESKWAKE_EXT}/cancel?uid=${uid})})
 same => n(done),Return()
`;
}

/** extensions_mobile_wake.conf with the feature off. */
export const MOBILE_WAKE_OFF_CONTENT = '; OpDesk mobile wake disabled\n';

/** The backend port the dialplan CURLs (env PORT, the port the server listens on). */
export function backendPort(): number {
  const n = parseInt(env('PORT', '8765'), 10);
  return Number.isFinite(n) && n > 0 ? n : 8765;
}

/** Write the mobile wake hook and make sure extensions_custom.conf includes it. */
export async function writeMobileWakeConf(
  opts: { backendPort?: number | null; holdSeconds?: number | null; settleSeconds?: number | null } = {},
): Promise<boolean> {
  const port = opts.backendPort ?? backendPort();
  const hold =
    opts.holdSeconds ??
    (await mobileWakeSetting('MOBILE_WAKE_WAIT', 'MOBILE_WAKE_WAIT', MOBILE_WAKE_WAIT_DEFAULT, MOBILE_WAKE_WAIT_MIN, MOBILE_WAKE_WAIT_MAX));
  const settle =
    opts.settleSeconds ??
    (await mobileWakeSetting('MOBILE_WAKE_SETTLE', 'MOBILE_WAKE_SETTLE', MOBILE_WAKE_SETTLE_DEFAULT, MOBILE_WAKE_SETTLE_MIN, MOBILE_WAKE_SETTLE_MAX));
  log.info('Writing mobile wake dialplan to %s', EXTENSIONS_MOBILE_WAKE_CONF);
  try {
    if (!(await sudoWrite(EXTENSIONS_MOBILE_WAKE_CONF, renderMobileWakeConf(port, hold, settle)))) return false;
    await ensureInclude(EXTENSIONS_MOBILE_WAKE_CONF);
    log.info('Mobile wake dialplan written to %s', EXTENSIONS_MOBILE_WAKE_CONF);
    return true;
  } catch (e) {
    log.error('Error writing mobile wake conf: %s', e);
    return false;
  }
}

/** Clear the mobile wake dialplan context (disables the feature). */
export async function removeMobileWakeConf(): Promise<boolean> {
  log.info('Clearing mobile wake dialplan from %s', EXTENSIONS_MOBILE_WAKE_CONF);
  try {
    if (!(await pathExists(EXTENSIONS_MOBILE_WAKE_CONF))) return true;
    if (!(await sudoWrite(EXTENSIONS_MOBILE_WAKE_CONF, MOBILE_WAKE_OFF_CONTENT))) return false;
    log.info('Mobile wake dialplan cleared');
    return true;
  } catch (e) {
    log.error('Error clearing mobile wake conf: %s', e);
    return false;
  }
}

/** Enable the mobile pre-dial wake dialplan and reload Asterisk. */
export async function enableMobileWake(holdSeconds: number | null = null, settleSeconds: number | null = null): Promise<boolean> {
  if (!(await writeMobileWakeConf({ holdSeconds, settleSeconds }))) return false;
  return reloadAsteriskDialplan();
}

/** Disable the mobile pre-dial wake dialplan and reload Asterisk. */
export async function disableMobileWake(): Promise<boolean> {
  if (!(await removeMobileWakeConf())) return false;
  return reloadAsteriskDialplan();
}

// ===========================================================================
// Call recording
// ===========================================================================

export const RECORDING_FORMATS: readonly string[] = ['wav', 'wav49', 'gsm', 'g722', 'ulaw', 'alaw', 'sln'];

// AstDB family for OpDesk's own keys. Recording policy lives under opdesk/rec/:
//   opdesk/rec/dir/<inbound|outbound|internal> = 0   that direction is not recorded
//   opdesk/rec/ext/<extension>                 = 0   calls involving that extension are not
// Opt-OUT: an absent key (or anything but "0") records.
export const ASTDB_FAMILY = 'opdesk';
export const REC_DIRECTIONS: readonly string[] = ['inbound', 'outbound', 'internal'];

// Tags the Gosub line injected into a pre-existing [macro-dialout-trunk-predial-hook] in
// extensions_custom.conf (see chainHookText).
export const OPDESK_REC_HOOK_MARK = '; OPDESK_REC_HOOK';
export const OPDESK_REC_HOOK_LINE = ' same => n,GosubIf($["${OPDESK_REC}"=""]?opdesk-record,s,1)';

/**
 * extensions_opdesk_record.conf with recording on.
 *
 * Why the predial hooks and NOT [from-internal-custom]: that context is only reachable
 * through the `_.` catch-all, the least-specific pattern; for any routed call a
 * more-specific pattern in ext-local / outrt-N wins and the catch-all never runs. FreePBX
 * instead ships two blank predial-hook stubs specifically so integrators can override them:
 *   macro-dialout-one-predial-hook    fires before dialling an extension (internal, inbound)
 *   macro-dialout-trunk-predial-hook  fires before dialling out a trunk (outbound)
 * Together they fire once per real call, on the originating channel, just before the
 * bridge. Defining them in a file #include'd by extensions_custom.conf wins the
 * duplicate-priority race against the blank stubs.
 *
 * Outputs (one MixMonitor, three files):
 *   mixed  RECORD_MIX_DIR/YYYY/MM/DD/<base>.<fmt>          (CDR(recordingfile) points here)
 *   sp1    RECORD_SINGLE_DIR/YYYY/MM/DD/<base>-sp1.<fmt>   (caller leg = r() receive)
 *   sp2    RECORD_SINGLE_DIR/YYYY/MM/DD/<base>-sp2.<fmt>   (callee leg = t() transmit)
 * <base> = <timestamp>-<cidnum>-<dialed>-<uniqueid>, FreePBX's naming style.
 *
 * MixMonitor runs with `b`: audio is written only while the channel is bridged, so the
 * files start at answer and hold no ring-back or early media; an unanswered leg leaves a
 * header-only file that vad-runner deletes. A channel flag (__OPDESK_REC) guards against
 * double-recording when a ring group / queue runs the hook once per member.
 *
 * Policy (opt-out, AstDB opdesk/rec/...): the call's direction (inbound when it arrived on
 * a DID, outbound when a trunk is being dialled, else internal), the calling extension
 * (AMPUSER, else the caller ID) and the dialled extension (EXTTOCALL) are each checked;
 * any one switched off skips the recording.
 *
 * When `vad` is on, the single-leg base is announced with UserEvent(OpDeskRecording) so the
 * AMI monitor can run the post-call voice-activity analysis (vad-runner) after hangup.
 */
export function renderRecordingConf(opts: { format: string; vad: boolean; pbx?: string | null }): string {
  const exit = hookExit(opts.pbx);
  const vadRecordLines = opts.vad
    ? ' same => n,Set(OPDESK_SINGLE_BASE=__SINGLEDIR__/${OPDESK_DAY}/${OPDESK_BASE})\n' +
      ' same => n,UserEvent(OpDeskRecording,Recbase: ${OPDESK_SINGLE_BASE})\n'
    : '';
  const template = `; OpDesk call recording dialplan — auto-generated. Do not edit manually.
;
; Records every real call (internal ext<->ext, inbound from trunks, outbound to trunks)
; with a single MixMonitor started from the PBX's predial hooks. [from-internal-custom]
; is NOT used on purpose: its \`_.\` entry is a catch-all that loses to the
; per-extension / per-route patterns and never runs for routed calls.
;
;   mixed -> __MIXDIR__/YYYY/MM/DD/<base>.__FMT__        (CDR default location, CDR-linked)
;   sp1   -> __SINGLEDIR__/YYYY/MM/DD/<base>-sp1.__FMT__ (caller leg, r() receive)
;   sp2   -> __SINGLEDIR__/YYYY/MM/DD/<base>-sp2.__FMT__ (callee leg, t() transmit)
;
; The predial-hook stubs ship blank in extensions.conf to be overridden; defining them
; here (included from extensions_custom.conf, parsed before the stubs) wins the
; duplicate-priority race so this version runs instead of the no-op stub.
;
; Policy (Settings -> Recordings) lives in the AstDB: opdesk/rec/dir/<direction> and
; opdesk/rec/ext/<extension> set to 0 switch recording off for that direction / extension.

[macro-dialout-one-predial-hook]
exten => s,1,GosubIf($["\${OPDESK_REC}"=""]?opdesk-record,s,1)
 same => n,__EXIT__

[macro-dialout-trunk-predial-hook]
exten => s,1,GosubIf($["\${OPDESK_REC}"=""]?opdesk-record,s,1)
 same => n,__EXIT__

[opdesk-record]
exten => s,1,NoOp(OpDesk recording start on \${CHANNEL})
 same => n,Set(__OPDESK_REC=1)
 same => n,Set(OPDESK_DIR=\${IF($["\${FROM_DID}"!=""]?inbound:\${IF($["\${DIAL_TRUNK}"!=""]?outbound:internal)})})
 same => n,GotoIf($["\${DB(opdesk/rec/dir/\${OPDESK_DIR})}"="0"]?skip)
 same => n,Set(OPDESK_EXT=\${IF($["\${AMPUSER}"!=""]?\${AMPUSER}:\${CALLERID(num)})})
 same => n,GotoIf($["\${DB(opdesk/rec/ext/\${OPDESK_EXT})}"="0"]?skip)
 same => n,GotoIf($["\${EXTTOCALL}"=""]?start)
 same => n,GotoIf($["\${DB(opdesk/rec/ext/\${EXTTOCALL})}"="0"]?skip)
 same => n(start),Set(OPDESK_TS=\${STRFTIME(\${EPOCH},,%Y%m%d-%H%M%S)})
 same => n,Set(OPDESK_DAY=\${STRFTIME(\${EPOCH},,%Y/%m/%d)})
 same => n,Set(OPDESK_DST=\${IF($["\${EXTTOCALL}"!=""]?\${EXTTOCALL}:\${CALLERID(dnid)})})
 same => n,Set(OPDESK_BASE=\${OPDESK_TS}-\${CALLERID(num)}-\${OPDESK_DST}-\${UNIQUEID})
 same => n,Set(OPDESK_MIX=__MIXDIR__/\${OPDESK_DAY}/\${OPDESK_BASE}.__FMT__)
 same => n,Set(OPDESK_SP1=__SINGLEDIR__/\${OPDESK_DAY}/\${OPDESK_BASE}-sp1.__FMT__)
 same => n,Set(OPDESK_SP2=__SINGLEDIR__/\${OPDESK_DAY}/\${OPDESK_BASE}-sp2.__FMT__)
 ; b = write audio only while this channel is bridged: the file starts the moment the
 ; called party answers and ends at hangup, so ring-back and early media never land in it.
 same => n,MixMonitor(\${OPDESK_MIX},br(\${OPDESK_SP1})t(\${OPDESK_SP2}))
 same => n,Set(CDR(recordingfile)=\${OPDESK_BASE}.__FMT__)
 same => n,NoOp(OpDesk recording: mix=\${OPDESK_MIX} sp1=\${OPDESK_SP1} sp2=\${OPDESK_SP2})
__VAD_RECORD_LINES__ same => n,Return()
 same => n(skip),NoOp(OpDesk recording skipped by policy: dir=\${OPDESK_DIR} ext=\${OPDESK_EXT} dst=\${EXTTOCALL})
 same => n,Return()
`;
  let content = template;
  content = pyReplace(content, '__VAD_RECORD_LINES__', vadRecordLines);
  content = pyReplace(content, '__EXIT__', exit);
  content = pyReplace(content, '__MIXDIR__', RECORD_MIX_DIR);
  content = pyReplace(content, '__SINGLEDIR__', RECORD_SINGLE_DIR);
  content = pyReplace(content, '__FMT__', opts.format);
  return content;
}

/**
 * extensions_opdesk_record.conf with recording off: the hook contexts stay, so they still
 * win the duplicate-priority race against the blank stubs, but start no MixMonitor.
 */
export function renderRecordingOffConf(pbx: string | null = null): string {
  const exit = hookExit(pbx);
  return (
    '; OpDesk call recording disabled\n' +
    '[macro-dialout-one-predial-hook]\n' +
    `exten => s,1,${exit}\n\n` +
    '[macro-dialout-trunk-predial-hook]\n' +
    `exten => s,1,${exit}\n`
  );
}

/**
 * `text` (extensions_custom.conf) with `line` injected into, or removed from, an existing
 * [macro-dialout-trunk-predial-hook] block; null when nothing changes.
 *
 * Asterisk uses FIRST-wins for duplicate contexts, and extensions_custom.conf is parsed
 * before the files it #includes -- so an install that already defines the trunk hook there
 * (sticky routing, "last agent" blocks) silently suppresses our own hook, and outbound
 * calls go unrecorded. Rather than fight the race, one tagged line is added right after the
 * block's `exten => s,1` line: idempotent (any earlier copy is stripped first) and cleanly
 * removable. With no such block this is a no-op and our file's hook takes effect.
 */
export function chainHookText(text: string, mark: string, line: string, enable: boolean): string | null {
  const lines = splitlines(text);
  const out = lines.filter((ln) => !ln.includes(mark));
  if (enable) {
    const hdr = '[macro-dialout-trunk-predial-hook]';
    const idx = out.findIndex((ln) => ln.trim() === hdr);
    if (idx !== -1) {
      let insertAt: number | null = null;
      for (let i = idx + 1; i < out.length; i++) {
        const s = out[i].trim();
        if (s.startsWith('[') && s.endsWith(']')) break; // next section: block had no exten line
        if (s.replace(/\s+/g, ' ').startsWith('exten => s,1')) {
          insertAt = i + 1;
          break;
        }
      }
      out.splice(insertAt ?? idx + 1, 0, `${line} ${mark}`);
    }
  }
  const content = out.join('\n') + '\n';
  return content === lines.join('\n') + '\n' ? null : content;
}

/** Chain [opdesk-record] into (or out of) a pre-existing trunk predial hook in extensions_custom.conf. */
export async function chainRecordIntoCustomHook(enable: boolean): Promise<boolean> {
  if (!(await pathExists(EXTENSIONS_CUSTOM_CONF))) return true;
  let text: string;
  try {
    text = await readText(EXTENSIONS_CUSTOM_CONF);
  } catch (e) {
    log.error('Could not read %s: %s', EXTENSIONS_CUSTOM_CONF, e);
    return false;
  }
  const next = chainHookText(text, OPDESK_REC_HOOK_MARK, OPDESK_REC_HOOK_LINE, enable);
  if (next === null) return true; // already in the wanted state; don't rewrite the file
  if (!(await sudoWrite(EXTENSIONS_CUSTOM_CONF, next))) return false;
  log.info('OPDESK_REC_HOOK %s trunk predial hook', enable ? 'chained into' : 'unchained from');
  return true;
}

/** The recording format: the DB setting the Settings UI writes, else env, else wav. */
export async function recordingFormat(): Promise<string> {
  let fmt: string | null = null;
  try {
    fmt = await dbm.getSetting('RECORDING_FORMAT', null);
  } catch {
    fmt = null;
  }
  fmt = (fmt || env('OPDESK_REC_FORMAT', '') || env('RECORDING_FORMAT', '') || 'wav').trim().toLowerCase();
  return RECORDING_FORMATS.includes(fmt) ? fmt : 'wav';
}

/**
 * Install full-call recording (see renderRecordingConf): write the file, make sure it is
 * included, chain into a colliding trunk hook. VAD needs 16-bit PCM, so it is switched off
 * for the other formats.
 */
export async function writeRecordingConf(
  opts: { mixFormat?: string | null; vad?: boolean; pbx?: string | null } = {},
): Promise<boolean> {
  const fmt = (opts.mixFormat || (await recordingFormat())).trim().toLowerCase();
  let vad = opts.vad ?? true;
  if (vad && !['wav', 'sln'].includes(fmt)) {
    log.warning('VAD analysis needs 16-bit PCM (wav/sln); format=%s -> disabling VAD', fmt);
    vad = false;
  }
  log.info('Writing call recording dialplan to %s (vad=%s)', EXTENSIONS_RECORD_CONF, vad);
  try {
    // MixMonitor creates the dated YYYY/MM/DD subdirs, but the single-leg base dir must
    // exist and be writable by the asterisk user first.
    await subprocessRun(['sudo', 'mkdir', '-p', RECORD_SINGLE_DIR]);
    await subprocessRun(['sudo', 'chown', 'asterisk:asterisk', RECORD_SINGLE_DIR]);
    await subprocessRun(['sudo', 'chmod', '775', RECORD_SINGLE_DIR]);

    if (!(await sudoWrite(EXTENSIONS_RECORD_CONF, renderRecordingConf({ format: fmt, vad, pbx: opts.pbx ?? null })))) {
      return false;
    }
    if (!(await ensureInclude(EXTENSIONS_RECORD_CONF))) return false;
    await chainRecordIntoCustomHook(true);
    log.info('Call recording dialplan written to %s', EXTENSIONS_RECORD_CONF);
    return true;
  } catch (e) {
    log.error('Error writing recording conf: %s', e);
    return false;
  }
}

/** Reset the recording predial hooks to no-ops (disables recording). */
export async function removeRecordingConf(pbx: string | null = null): Promise<boolean> {
  log.info('Clearing call recording dialplan from %s', EXTENSIONS_RECORD_CONF);
  try {
    if (!(await pathExists(EXTENSIONS_RECORD_CONF))) {
      await chainRecordIntoCustomHook(false);
      return true;
    }
    if (!(await sudoWrite(EXTENSIONS_RECORD_CONF, renderRecordingOffConf(pbx)))) return false;
    await ensureInclude(EXTENSIONS_RECORD_CONF);
    // Remove the injected Gosub from the trunk predial hook (leave the rest of the block).
    await chainRecordIntoCustomHook(false);
    log.info('Call recording dialplan cleared');
    return true;
  } catch (e) {
    log.error('Error clearing recording conf: %s', e);
    return false;
  }
}

/** The predial hooks [opdesk-record] runs from (see renderRecordingConf). */
export const RECORD_HOOK_CONTEXTS: readonly string[] = ['macro-dialout-one-predial-hook', 'macro-dialout-trunk-predial-hook'];

/** A predial hook that, in the loaded dialplan, does not run [opdesk-record]. */
export interface RecordingHookConflict {
  context: string;
  /** The file whose definition won (e.g. another recorder's), null when the hook is missing. */
  file: string | null;
}

/**
 * The predial hooks that do NOT reach [opdesk-record] in the dialplan Asterisk has loaded:
 * [] when recording is wired, null when Asterisk could not be asked.
 *
 * Duplicate contexts are first-wins: a file #included before extensions_opdesk_record.conf
 * that defines the same hooks (another recorder, such as Echo) keeps them, Asterisk only
 * logs "already in use", and every call goes unrecorded by OpDesk -- or recorded by the
 * other product under its own policy. Writing the file and reloading cannot tell; reading
 * back what was loaded can.
 */
export async function recordingHookConflicts(): Promise<RecordingHookConflict[] | null> {
  const out: RecordingHookConflict[] = [];
  for (const context of RECORD_HOOK_CONTEXTS) {
    let text: string;
    try {
      const r = await subprocessRun(['sudo', 'asterisk', '-rx', `dialplan show s@${context}`], { timeout: 10 });
      if (r.returncode !== 0) return null;
      text = r.stdout || '';
    } catch (e) {
      log.warning('Could not read the %s dialplan: %s', context, e);
      return null;
    }
    if (text.includes('opdesk-record')) continue;
    const m = /\[([^\]:\s]+\.conf):\d+\]/.exec(text);
    out.push({ context, file: m ? m[1] : null });
  }
  return out;
}

/** Enable full-call MixMonitor recording (+ post-call VAD) and reload the dialplan. */
export async function enableRecording(
  opts: { mixFormat?: string | null; vad?: boolean; pbx?: string | null } = {},
): Promise<boolean> {
  if (!(await writeRecordingConf(opts))) return false;
  return reloadAsteriskDialplan();
}

/** Disable full-call recording and reload the dialplan. */
export async function disableRecording(pbx: string | null = null): Promise<boolean> {
  if (!(await removeRecordingConf(pbx))) return false;
  return reloadAsteriskDialplan();
}

// ---------------------------------------------------------------------------
// Recording policy (AstDB opdesk/rec/...)
// ---------------------------------------------------------------------------

/** AstDB keys are path segments; an extension is digits, a direction a fixed word. */
function astdbKeyPart(v: string): string | null {
  return /^[A-Za-z0-9_*#+.-]{1,40}$/.test(v) ? v : null;
}

/** Set one AstDB entry via the CLI (the mechanism FreePBX/IssabelPBX use themselves). */
export async function astdbPut(family: string, key: string, value: string): Promise<boolean> {
  try {
    const r = await subprocessRun(['sudo', 'asterisk', '-rx', `database put ${family} ${key} ${value}`], { timeout: 10 });
    if (r.returncode === 0 && (r.stdout || '').toLowerCase().includes('success')) return true;
    log.error('database put %s %s %s failed: %s %s', family, key, value, (r.stdout || '').trim(), (r.stderr || '').trim());
    return false;
  } catch (e) {
    log.error('database put %s %s error: %s', family, key, e);
    return false;
  }
}

/** Read one AstDB entry via the CLI; '' if unset. */
export async function astdbGet(family: string, key: string): Promise<string> {
  try {
    const r = await subprocessRun(['sudo', 'asterisk', '-rx', `database get ${family} ${key}`], { timeout: 10 });
    const out = (r.stdout || '').trim();
    return out.toLowerCase().startsWith('value:') ? out.slice(out.indexOf(':') + 1).trim() : '';
  } catch (e) {
    log.error('database get %s %s error: %s', family, key, e);
    return '';
  }
}

/** Delete one AstDB entry via the CLI. True when it is gone (absent counts). */
export async function astdbDel(family: string, key: string): Promise<boolean> {
  try {
    await subprocessRun(['sudo', 'asterisk', '-rx', `database del ${family} ${key}`], { timeout: 10 });
    return true;
  } catch (e) {
    log.error('database del %s %s error: %s', family, key, e);
    return false;
  }
}

/**
 * The parsed `database show opdesk/rec` listing: {directions: {inbound,outbound,internal},
 * extensions_opted_out: [...]}. Pure, for tests.
 */
export function parseRecordingPolicy(showOutput: string): { directions: Record<string, boolean>; extensions_opted_out: string[] } {
  const directions: Record<string, boolean> = { inbound: true, outbound: true, internal: true };
  const optedOut = new Set<string>();
  for (const line of splitlines(showOutput || '')) {
    // /opdesk/rec/dir/inbound : 0      /opdesk/rec/ext/100 : 0
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const parts = line.slice(0, colon).trim().replace(/^\/+|\/+$/g, '').split('/');
    const value = line.slice(colon + 1).trim();
    if (parts.length !== 4 || parts[0] !== ASTDB_FAMILY || parts[1] !== 'rec') continue;
    if (parts[2] === 'dir' && REC_DIRECTIONS.includes(parts[3])) directions[parts[3]] = value !== '0';
    else if (parts[2] === 'ext' && value === '0') optedOut.add(parts[3]);
  }
  return { directions, extensions_opted_out: [...optedOut].sort() };
}

/**
 * The OpDesk recorder's policy: per-direction on/off and the extensions explicitly opted
 * OUT. One `database show` call, so it scales to hundreds of extensions.
 */
export async function getRecordingPolicy(): Promise<{ directions: Record<string, boolean>; extensions_opted_out: string[] }> {
  try {
    const r = await subprocessRun(['sudo', 'asterisk', '-rx', `database show ${ASTDB_FAMILY}/rec`], { timeout: 15 });
    return parseRecordingPolicy(r.stdout || '');
  } catch (e) {
    log.error('database show %s/rec failed: %s', ASTDB_FAMILY, e);
    return parseRecordingPolicy('');
  }
}

/** Enable/disable recording for one direction (inbound/outbound/internal). */
export async function setRecordingDirection(direction: string, enabled: boolean): Promise<boolean> {
  if (!REC_DIRECTIONS.includes(direction)) return false;
  return astdbPut(ASTDB_FAMILY, `rec/dir/${direction}`, enabled ? '1' : '0');
}

/** Record (true) or don't record (false) calls involving this extension. */
export async function setRecordingExtension(ext: unknown, enabled: boolean): Promise<boolean> {
  const e = astdbKeyPart(pyStr(ext).trim());
  if (!e) return false;
  if (enabled) return astdbDel(ASTDB_FAMILY, `rec/ext/${e}`);
  return astdbPut(ASTDB_FAMILY, `rec/ext/${e}`, '0');
}

// ===========================================================================
// SIP TLS
// ===========================================================================

// Markers written around OpDesk's TLS block so it can be found and removed cleanly.
export const TLS_MARKER_START = '; --- OpDesk SIP TLS BEGIN ---';
export const TLS_MARKER_END = '; --- OpDesk SIP TLS END ---';
export const TLS_CERT = '/etc/asterisk/keys/opdesk_le_fullchain.pem';
export const TLS_KEY = '/etc/asterisk/keys/opdesk_le_privkey.pem';
export const TLS_PORT = 5061;

/**
 * ('freepbx', file) or ('issabel', file): where OpDesk's TLS transport goes.
 *
 *   FreePBX  has the auto-generated pjsip.transports.conf; a complete [0.0.0.0-tls] in
 *            pjsip.transports_custom.conf (included inside it, before the generated
 *            section) wins first-wins.
 *   Issabel  has no pjsip.transports.conf; pjsip.conf includes pjsip_custom_post.conf last,
 *            so a dedicated [opdesk-sip-tls] transport goes there.
 * PBX=Issabel decides outright; otherwise the files on disk do, as the Python did.
 */
export async function detectTlsMode(pbx: string | null = null): Promise<[PbxKind, string]> {
  if (pbxKind(pbx) === 'issabel') return ['issabel', PJSIP_CUSTOM_POST];
  if (await isFile('/etc/asterisk/pjsip.transports.conf')) return ['freepbx', PJSIP_TRANSPORTS_CUSTOM];
  for (const candidate of [PJSIP_CUSTOM_POST, '/etc/asterisk/pjsip_custom.conf']) {
    if (await isFile(candidate)) return ['issabel', candidate];
  }
  return ['issabel', PJSIP_CUSTOM_POST];
}

/** `text` without OpDesk's TLS marker block(s); everything else is left as it was. */
export function stripTlsBlock(text: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of splitlines(text, true)) {
    if (line.includes(TLS_MARKER_START)) inside = true;
    if (!inside) out.push(line);
    if (line.includes(TLS_MARKER_END)) inside = false;
  }
  return out.join('');
}

/**
 * The PJSIP TLS transport block. method=tlsv1_2 is required on OpenSSL 3.x (the FreePBX
 * default "sslv23" throws "no protocols available" because SSLv3/TLS1.0/1.1 are disabled).
 */
export function renderTlsBlock(mode: PbxKind, cert = TLS_CERT, key = TLS_KEY): string {
  return (
    `${TLS_MARKER_START}\n` +
    `[${mode === 'freepbx' ? '0.0.0.0-tls' : 'opdesk-sip-tls'}]\n` +
    'type=transport\n' +
    'protocol=tls\n' +
    `bind=0.0.0.0:${TLS_PORT}\n` +
    `cert_file=${cert}\n` +
    `priv_key_file=${key}\n` +
    'method=tlsv1_2\n' +
    'verify_client=no\n' +
    'verify_server=no\n' +
    `${TLS_MARKER_END}\n`
  );
}

/**
 * The new content of the transport file: whatever was there minus any earlier OpDesk block,
 * plus the current block. Re-enabling therefore replaces the block instead of stacking a
 * second copy, and other custom transports in the file survive.
 */
export function renderTlsFile(existing: string, mode: PbxKind, cert = TLS_CERT, key = TLS_KEY): string {
  const kept = stripTlsBlock(existing).replace(/\n+$/, '');
  return (kept ? kept + '\n\n' : '') + renderTlsBlock(mode, cert, key);
}

/** Overwrite a root-owned file via `sudo tee`. */
export async function writeToFile(filePath: string, content: string): Promise<boolean> {
  try {
    const result = await subprocessRun(['sudo', 'tee', filePath], { input: content });
    if (result.returncode !== 0) {
      log.error('tee %s failed: %s', filePath, result.stderr);
      return false;
    }
    return true;
  } catch (e) {
    log.error('Failed to write %s: %s', filePath, e);
    return false;
  }
}

/** Read a root-owned file via `sudo cat`; '' when it does not exist. */
async function sudoRead(filePath: string): Promise<string | null> {
  if (!(await isFile(filePath))) return '';
  const r = await subprocessRun(['sudo', 'cat', filePath]);
  return r.returncode === 0 ? r.stdout : null;
}

/**
 * Restart Asterisk to pick up transport changes: TLS transports have allow_reload=false, so
 * a module reload is not enough. 'core restart now' rather than 'graceful', which waits for
 * every active call to end and on a busy PBX may never fire.
 */
export async function restartAsterisk(): Promise<boolean> {
  try {
    const result = await subprocessRun(['sudo', 'asterisk', '-rx', 'core restart now'], { timeout: 30 });
    if (result.returncode !== 0) {
      log.error('Asterisk restart failed: %s', result.stderr);
      return false;
    }
    log.info('Asterisk restarted — TLS transport changes applied');
    return true;
  } catch (e) {
    log.error('Asterisk restart failed: %s', e);
    return false;
  }
}

/**
 * Open (or close) the TLS port in ufw when ufw is the firewall. Issabel's firewall is its
 * own iptables front end (rules in /var/www/db/iptables.db; hand-made rules are lost on the
 * next apply), so there the admin is told what to open instead. Best effort either way.
 */
async function firewallTlsPort(open: boolean, mode: PbxKind): Promise<void> {
  const ufw = (await isFile('/usr/sbin/ufw')) ? '/usr/sbin/ufw' : (await isFile('/usr/bin/ufw')) ? '/usr/bin/ufw' : null;
  if (!ufw) {
    if (open) {
      log.info(
        mode === 'issabel'
          ? 'Open TCP %s in Issabel Security -> Firewall so phones can reach SIP TLS'
          : 'No ufw found; make sure TCP %s is open in the firewall for SIP TLS',
        TLS_PORT,
      );
    }
    return;
  }
  const verb = open ? ['allow'] : ['delete', 'allow'];
  try {
    for (const proto of ['tcp', 'udp']) await subprocessRun(['sudo', ufw, ...verb, `${TLS_PORT}/${proto}`]);
    await subprocessRun(['sudo', ufw, 'reload']);
  } catch (e) {
    log.warning('ufw update for port %s failed: %s', TLS_PORT, e);
  }
}

/** Enable SIP TLS on port 5061 using the Let's Encrypt cert for `domain`. */
export async function enableSipTls(domain: string, pbx: string | null = null): Promise<boolean> {
  const leCert = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const leKey = `/etc/letsencrypt/live/${domain}/privkey.pem`;
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) {
    log.error("Invalid domain for SIP TLS: '%s'", domain);
    return false;
  }
  // /etc/letsencrypt/live is root-only: when the backend is not root, look through sudo.
  const exists = async (p: string): Promise<boolean> =>
    (await isFile(p)) || subprocessRun(['sudo', 'test', '-f', p]).then((r) => r.returncode === 0).catch(() => false);
  const certThere = await exists(leCert);
  const keyThere = await exists(leKey);
  if (!certThere || !keyThere) {
    log.error("Let's Encrypt cert not found for domain '%s'. Expected: %s", domain, leCert);
    return false;
  }
  // Copy into /etc/asterisk/keys/ where asterisk has access.
  for (const [src, dst, perms] of [
    [leCert, TLS_CERT, '644'],
    [leKey, TLS_KEY, '600'],
  ]) {
    const r = await subprocessRun(['sudo', 'cp', '-L', src, dst]);
    if (r.returncode !== 0) {
      log.error('Failed to copy %s → %s: %s', src, dst, r.stderr);
      return false;
    }
    await subprocessRun(['sudo', 'chown', 'asterisk:asterisk', dst]);
    await subprocessRun(['sudo', 'chmod', perms, dst]);
  }

  const [mode, configFile] = await detectTlsMode(pbx);
  log.info('SIP TLS mode detected: %s → %s', mode, configFile);
  const existing = await sudoRead(configFile);
  if (existing === null) {
    log.error('Could not read %s', configFile);
    return false;
  }
  if (!(await writeToFile(configFile, renderTlsFile(existing, mode)))) return false;
  await firewallTlsPort(true, mode);
  if (!(await restartAsterisk())) return false;
  log.info('SIP TLS enabled on port %s (%s) with cert for %s', TLS_PORT, mode, domain);
  return true;
}

/** Disable SIP TLS on port 5061: remove OpDesk's block, close the port, restart Asterisk. */
export async function disableSipTls(pbx: string | null = null): Promise<boolean> {
  const [mode, configFile] = await detectTlsMode(pbx);
  log.info('SIP TLS disable: mode=%s, file=%s', mode, configFile);
  const existing = await sudoRead(configFile);
  if (existing && existing.includes(TLS_MARKER_START)) {
    await writeToFile(configFile, stripTlsBlock(existing));
  }
  await firewallTlsPort(false, mode);
  if (!(await restartAsterisk())) return false;
  log.info('SIP TLS disabled on port %s', TLS_PORT);
  return true;
}

/** True when the setting value reads as on ('true', '1', 'yes'). */
export function settingOn(v: unknown): boolean {
  return truthy(v) && ['true', '1', 'yes'].includes(String(v).trim().toLowerCase());
}
