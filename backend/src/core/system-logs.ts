/**
 * System Logs panel feed: the live AMI event buffer and the SIP tracer that tails the Asterisk log.
 *
 * Python: the "System Logs" section of server.py (AMIEventBuffer, SipTracer).
 */

import { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import { env } from './config';
import { getLogger } from './logger';
import { time } from './py';

const log = getLogger('core.system_logs');

// ---------------------------------------------------------------------------
// System Logs — live Asterisk AMI event stream
// ---------------------------------------------------------------------------
//
// The System Logs panel shows the raw AMI event feed. The monitor calls our raw-event
// sink for every parsed event (monitor.setRawEventSink(amiEventBuffer.add)) BEFORE the
// WATCHED_EVENTS filter, so the panel sees the whole stream rather than the events the
// app itself acts on.
//
// In memory only — capped at AMI_BUFFER_CAPACITY events and lost on restart. That is
// deliberate: this is a live debugging console, not an audit trail, and persisting a
// high-rate event feed would cost far more than it is worth. Buffering is OFF by default
// so the steady-state cost is one property read per AMI event.

// AMI fields that are pure plumbing/noise — hidden from the one-line summary (kept
// in `fields` so the expanded view still has them).
export const AMI_SUMMARY_SKIP = new Set(['Event', 'Privilege', 'SystemName', 'Timestamp']);
// Capacity is generous because AMI can be chatty under load.
export const AMI_BUFFER_CAPACITY = 3000;

export interface LogEntry {
  seq: number;
  event: string;
  ts: number;
  summary: string;
  fields: Record<string, unknown>;
}

/** Retains the most recent AMI events in memory for the System Logs panel. */
export class AMIEventBuffer {
  /** deque(maxlen=capacity): oldest entries fall off the front. */
  buf: LogEntry[] = [];
  seq = 0;
  // The Python guarded this with a threading.Lock because the SIP tracer thread also
  // appended. Node is single threaded, so every method here is already atomic.
  enabled = false;
  readonly capacity: number;

  constructor(capacity = AMI_BUFFER_CAPACITY) {
    this.capacity = capacity;
    // Handed to the monitor as a bare callable (monitor.setRawEventSink(amiEventBuffer.add)).
    this.add = this.add.bind(this);
  }

  private append(entry: LogEntry): void {
    this.buf.push(entry);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  /**
   * Sink: record one parsed AMI event.
   *
   * Runs on the AMI read path for EVERY event, so it must stay synchronous and cheap —
   * never add a DB write or a broadcast here or AMI event processing stalls globally.
   */
  add(event: Record<string, unknown>): void {
    if (!this.enabled) return;
    const ev = 'Event' in event ? event.Event : '';
    if (!ev) return;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event)) if (k !== 'Event') fields[k] = v;
    const summary = Object.entries(event)
      .filter(([k, v]) => !AMI_SUMMARY_SKIP.has(k) && v)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    this.seq += 1;
    this.append({ seq: this.seq, event: String(ev), ts: time(), summary, fields });
  }

  /**
   * Return buffered events newer than `since`, optionally filtered by event-name
   * substring and free-text `q` (matches event name or summary). Oldest first.
   */
  snapshot(opts: { since?: number; event?: string; q?: string; limit?: number } = {}): LogEntry[] {
    const since = opts.since ?? 0;
    const evL = (opts.event ?? '').toLowerCase();
    const qL = (opts.q ?? '').toLowerCase();
    const limit = opts.limit ?? 2000;
    let rows = this.buf.filter(
      (e) =>
        e.seq > since &&
        (!evL || e.event.toLowerCase().includes(evL)) &&
        (!qL || e.event.toLowerCase().includes(qL) || e.summary.toLowerCase().includes(qL)),
    );
    if (rows.length > limit) rows = rows.slice(-limit);
    return rows;
  }

  /**
   * Record a SIP message captured by the SIP tracer as a synthetic 'SIP' entry.
   *
   * Not gated on `enabled`: the SIP toggle is its own switch, so a trace can be watched
   * without also buffering the whole AMI feed.
   */
  addSip(summary: string, raw: string): void {
    this.seq += 1;
    this.append({ seq: this.seq, event: 'SIP', ts: time(), summary, fields: { Message: raw } });
  }

  /** Distinct event names currently buffered (sorted), for the filter dropdown. */
  eventNames(): string[] {
    const names = new Set(this.buf.map((e) => e.event));
    return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

/** Single shared buffer; wired to the AMI monitor at startup (see lifespan). */
export const amiEventBuffer = new AMIEventBuffer();

// ---------------------------------------------------------------------------
// System Logs — raw SIP message trace
// ---------------------------------------------------------------------------
// Asterisk writes SIP messages to its own log file when the PJSIP logger is on, not
// over AMI. To interleave them with the AMI feed we tail that file, reassemble each
// multi-line SIP block, and push it into the same buffer as a 'SIP' entry.

/**
 * The Asterisk "full" log. FreePBX and Issabel both log there (logger.conf `full =>`);
 * override with ASTERISK_LOG_FILE if a box logs elsewhere.
 */
export const ASTERISK_LOG_FILE = env('ASTERISK_LOG_FILE', '/var/log/asterisk/full');

export const SIP_START_RE = /<---\s*(Received|Transmitting|Sending)/i;
export const SIP_END_RE = /^<-{3,}>$/;

/** OSError.strerror for the errno codes an open() of a log file realistically hits. */
const STRERROR: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long',
  EMFILE: 'Too many open files',
  EIO: 'Input/output error',
};

function strerror(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code && STRERROR[code]) return STRERROR[code];
  return e instanceof Error ? e.message : String(e);
}

/** threading.Event: set/isSet and a wait(timeout) that set() cuts short. */
class StopEvent {
  private flag = false;
  private waiters: (() => void)[] = [];

  set(): void {
    this.flag = true;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  isSet(): boolean {
    return this.flag;
  }

  wait(seconds: number): Promise<void> {
    if (this.flag) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((x) => x !== done);
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      this.waiters.push(done);
    });
  }
}

/**
 * A text-mode file reader with Python's readline(): universal newlines ('\r\n', '\r' and
 * '\n' all read as '\n'), undecodable bytes replaced, and a partial last line returned
 * as-is when no newline has been written yet ('' only when there is no new data).
 */
class LineReader {
  private pending: Buffer = Buffer.alloc(0);
  private chunk = Buffer.alloc(64 * 1024);

  constructor(
    readonly fh: FileHandle,
    private position: number,
  ) {}

  private async fill(): Promise<number> {
    const { bytesRead } = await this.fh.read(this.chunk, 0, this.chunk.length, this.position);
    if (bytesRead > 0) {
      this.position += bytesRead;
      this.pending = Buffer.concat([this.pending, this.chunk.subarray(0, bytesRead)]);
    }
    return bytesRead;
  }

  async readline(): Promise<string> {
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.pending.length; i++) {
        const b = this.pending[i];
        if (b === 0x0a || b === 0x0d) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        let end = idx + 1;
        if (this.pending[idx] === 0x0d) {
          if (end >= this.pending.length) await this.fill();
          if (end < this.pending.length && this.pending[end] === 0x0a) end += 1;
        }
        const line = this.pending.subarray(0, idx).toString('utf8') + '\n';
        this.pending = this.pending.subarray(end);
        return line;
      }
      const n = await this.fill();
      if (n === 0) {
        const line = this.pending.toString('utf8');
        this.pending = Buffer.alloc(0);
        return line;
      }
    }
  }

  async close(): Promise<void> {
    await this.fh.close();
  }
}

/**
 * Tails the Asterisk log file and feeds reassembled SIP messages to the buffer.
 *
 * The Python ran this in a daemon thread because the tail is blocking file IO; here it is
 * a background async loop. Start/stop is driven by the panel's SIP toggle; `lastError`
 * surfaces a path/permission problem back to the UI instead of failing silently.
 */
export class SipTracer {
  buffer: AMIEventBuffer;
  logPath: string;
  enabled = false;
  lastError: string | null = null;
  loop: Promise<void> | null = null;
  stopEvent = new StopEvent();

  constructor(buffer: AMIEventBuffer, logPath: string) {
    this.buffer = buffer;
    this.logPath = logPath;
  }

  async start(): Promise<boolean> {
    if (this.enabled) return true;
    // Verify the file is actually readable before claiming success — the common
    // failure here is a permission or path problem, not a runtime one.
    try {
      await (await fsp.open(this.logPath, 'r')).close();
    } catch (e) {
      this.lastError = `Cannot read ${this.logPath}: ${strerror(e)}`;
      log.warning('SIP tracer: %s', this.lastError);
      return false;
    }
    // A second start() that raced the await above lost.
    if (this.enabled) return true;
    this.lastError = null;
    // Each run gets its own stop event, so a loop stopped just before a restart still exits.
    this.stopEvent = new StopEvent();
    this.loop = this.run();
    this.enabled = true;
    return true;
  }

  stop(): void {
    this.stopEvent.set();
    this.enabled = false;
  }

  emit(block: string[]): void {
    const header = block[0];
    const idx = header.indexOf('<---');
    const htext = idx >= 0 ? header.slice(idx) : header;
    const summary = htext.split('<---').join('').split('--->').join('').trim();
    this.buffer.addSip(summary || 'SIP message', block.join('\n'));
  }

  async run(): Promise<void> {
    // This loop holds the stop event it was started with: a stop() followed by start()
    // before it wakes cannot revive it.
    const stopEvent = this.stopEvent;
    let f: LineReader | null = null;
    let inode: number | null = null;
    let block: string[] = [];
    let inBlock = false;
    while (!stopEvent.isSet()) {
      try {
        if (f === null) {
          const fh = await fsp.open(this.logPath, 'r');
          const st = await fh.stat();
          f = new LineReader(fh, st.size); // seek(0, SEEK_END)
          inode = st.ino;
        }
        let line = await f.readline();
        if (!line) {
          // No new data: check for log rotation, then wait briefly.
          try {
            if ((await fsp.stat(this.logPath)).ino !== inode) {
              await f.close();
              f = null;
              continue;
            }
          } catch {
            // OSError: keep reading the old handle
          }
          await stopEvent.wait(0.4);
          continue;
        }
        line = line.replace(/\n$/, '');
        const stripped = line.trim();
        if (SIP_START_RE.test(line)) {
          // A new block starts; flush any unterminated previous block.
          if (inBlock && block.length > 1) this.emit(block);
          inBlock = true;
          block = [line];
        } else if (inBlock) {
          if (SIP_END_RE.test(stripped)) {
            this.emit(block);
            inBlock = false;
            block = [];
          } else {
            block.push(line);
            if (block.length > 300) {
              // safety cap against a runaway block
              this.emit(block);
              inBlock = false;
              block = [];
            }
          }
        }
      } catch (e) {
        log.debug('SIP tracer tail error: %s', e);
        try {
          if (f) await f.close();
        } catch {
          // ignore
        }
        f = null;
        await stopEvent.wait(1.0);
      }
    }
    if (f) {
      try {
        await f.close();
      } catch {
        // ignore
      }
    }
  }
}

export const sipTracer = new SipTracer(amiEventBuffer, ASTERISK_LOG_FILE);
