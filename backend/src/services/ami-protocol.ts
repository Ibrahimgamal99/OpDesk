/**
 * Asterisk Manager Interface wire protocol: framing, parsing and an action/response client.
 *
 * The Python monitor (backend/ami.py) shared one socket between three readers (the event
 * loop, `_send_async` and `_send_action_with_events`) behind a lock, and returned "whatever
 * arrived next" as an action's reply. That mixes unsolicited events into replies, drops
 * events read while an action waited, and can hand one action another action's reply.
 *
 * This client has exactly ONE reader. Every byte goes through AmiFramer, which cuts the
 * stream into messages; each message is then routed:
 *
 *   * `Response:` carrying the ActionID of a pending action  -> that action's reply
 *   * `Event:` carrying the ActionID of a pending list action -> collected into its reply
 *     (QueueStatus / Status / QueueSummary / CoreShowChannels answer with an event list)
 *   * any other `Event:`                                      -> onEvent (the live feed)
 *   * stale/foreign responses                                 -> dropped
 *
 * so an action's reply can never contain someone else's data and no event is ever lost
 * while an action is in flight.
 *
 * Asterisk differences handled here (Issabel 5 ships Asterisk 16/18/20, FreePBX 22):
 *   * `Command` replies: Asterisk <= 13 answers `Response: Follows` with the raw CLI text
 *     terminated by `--END COMMAND--`; 14+ answers `Response: Success` with one `Output:`
 *     header per line. Both are framed as one message.
 *   * List actions end with `EventList: Complete` on 13+; older versions only send the
 *     `<Action>Complete` event. Either ends the list.
 */

import * as net from 'net';
import { amiActionAllowed, refused } from '../core/shadow';

/** One parsed AMI message: header -> value (first occurrence of a repeated header wins). */
export type AmiMessage = Record<string, string>;

export const AMI_RESPONSE_END = '\r\n\r\n';
export const AMI_TIMEOUT = 5.0; // seconds an ordinary action may take to answer
export const AMI_LIST_TIMEOUT = 10.0; // seconds a list action (QueueStatus, Status, ...) may take
const LEGACY_COMMAND_END = '--END COMMAND--';

/**
 * Parse AMI `Key: value` lines into a dict (Python `_parse`).
 *
 * Splits each line on the FIRST colon and trims both sides. When a header repeats (the
 * `Output:` lines of a Command reply, `Variable:` in some events) the FIRST value is kept,
 * which is what every caller here wants; `parseAll` returns the repeats.
 */
export function parse(response: string): AmiMessage {
  const out: AmiMessage = Object.create(null) as AmiMessage;
  for (const line of response.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = line.slice(i + 1).trim();
  }
  // A plain object (not null-prototype) so callers can spread / JSON it like a dict.
  return { ...out };
}

/** Every value of a repeated header, in order (e.g. the `Output:` lines of a Command reply). */
export function parseAll(response: string, key: string): string[] {
  const out: string[] = [];
  for (const line of response.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    if (line.slice(0, i).trim() === key) out.push(line.slice(i + 1).trim());
  }
  return out;
}

/**
 * Text of a CLI `Command` reply, one string per output line, for both reply shapes:
 * `Output: <line>` headers (Asterisk 14+) and the raw legacy body (`Response: Follows`).
 */
export function commandOutputLines(raw: string): string[] {
  const outputs = parseAll(raw, 'Output');
  if (outputs.length) return outputs;
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t === LEGACY_COMMAND_END) continue;
    if (/^(Response|Privilege|ActionID|Message):/i.test(t)) continue;
    lines.push(t);
  }
  return lines;
}

/**
 * Cuts the AMI byte stream into messages. Feed it decoded text in any chunking; it returns
 * the complete messages (each WITHOUT its trailing blank line) and keeps the partial tail.
 *
 * The first line Asterisk sends is the banner (`Asterisk Call Manager/x.y`), terminated by
 * a single CRLF rather than a blank line; it is returned once via `banner`.
 */
export class AmiFramer {
  private buf = '';
  banner: string | null = null;
  private bannerExpected: boolean;

  constructor(expectBanner = true) {
    this.bannerExpected = expectBanner;
  }

  feed(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    if (this.bannerExpected) {
      const nl = this.buf.indexOf('\r\n');
      if (nl === -1) return out;
      this.banner = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      this.bannerExpected = false;
    }
    for (;;) {
      // Strip blank lines between messages (some Asterisk versions emit an extra CRLF).
      while (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2);
      if (!this.buf) break;
      if (/^Response:\s*Follows/i.test(this.buf)) {
        // Legacy Command reply: the body may itself contain blank lines; it ends at
        // --END COMMAND-- followed by the message terminator.
        const end = this.buf.indexOf(LEGACY_COMMAND_END);
        if (end === -1) break;
        const term = this.buf.indexOf(AMI_RESPONSE_END, end);
        if (term === -1) break;
        out.push(this.buf.slice(0, term));
        this.buf = this.buf.slice(term + AMI_RESPONSE_END.length);
        continue;
      }
      const idx = this.buf.indexOf(AMI_RESPONSE_END);
      if (idx === -1) break;
      const msg = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + AMI_RESPONSE_END.length);
      if (msg.trim()) out.push(msg);
    }
    return out;
  }

  /** Bytes received but not yet framed (a partial message). */
  pending(): string {
    return this.buf;
  }

  reset(expectBanner = true): void {
    this.buf = '';
    this.banner = null;
    this.bannerExpected = expectBanner;
  }
}

/**
 * Render one action. Header values are single-line by protocol: a CR or LF inside a value
 * would start a new header (or a whole new action), so they are stripped — the AMI header
 * injection the Python only avoided by validating each caller's input.
 */
export function renderAction(action: string, actionId: string | null, params: Record<string, unknown> | null): string {
  const clean = (v: unknown) => String(v ?? '').replace(/[\r\n]+/g, ' ');
  const parts = [`Action: ${clean(action)}\r\n`];
  if (actionId) parts.push(`ActionID: ${clean(actionId)}\r\n`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      parts.push(`${clean(k)}: ${clean(v)}\r\n`);
    }
  }
  parts.push('\r\n');
  return parts.join('');
}

interface PendingAction {
  action: string;
  /** null for a single-reply action; the event that ends the list otherwise. */
  completeEvent: string | null;
  raw: string[]; // the reply message(s), raw text, response first
  gotResponse: boolean;
  timer: NodeJS.Timeout;
  resolve: (msgs: string[] | null) => void;
}

export interface AmiClientOptions {
  /** Called for every unsolicited event, in arrival order, with the raw message text. */
  onEvent?: (raw: string) => void;
  /** Called once when the socket closes (for any reason). */
  onClose?: (err: Error | null) => void;
  /** Prefix for generated ActionIDs, so our replies are recognisable. */
  actionIdPrefix?: string;
}

/**
 * One AMI connection. connect() resolves after the banner; login() authenticates. All
 * methods resolve (never reject) on a dead socket: an action on a closed connection
 * answers null, exactly like the Python `_send_async` did when not connected.
 */
export class AmiClient {
  private sock: net.Socket | null = null;
  private framer = new AmiFramer(true);
  private pending = new Map<string, PendingAction>();
  private counter = 0;
  private readonly prefix: string;
  connected = false;
  banner = '';

  constructor(private readonly opts: AmiClientOptions = {}) {
    this.prefix = opts.actionIdPrefix || 'opdesk';
  }

  /** Open the TCP connection and wait for the banner line (or `timeout` seconds). */
  async connect(host: string, port: number, timeout = AMI_TIMEOUT): Promise<void> {
    this.framer.reset(true);
    const sock = net.connect({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30_000);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        sock.destroy();
        reject(new Error(`Timed out connecting to AMI at ${host}:${port}`));
      }, timeout * 1000);
      const onData = () => {
        if (this.framer.banner !== null) {
          cleanup();
          resolve();
        }
      };
      const onError = (e: Error) => {
        cleanup();
        sock.destroy();
        reject(e);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('AMI connection closed before the banner'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        sock.off('error', onError);
        sock.off('close', onClose);
        sock.off('data', onData);
      };
      sock.on('data', (d: Buffer) => this.onData(d));
      sock.on('data', onData);
      sock.once('error', onError);
      sock.once('close', onClose);
    });
    this.banner = this.framer.banner || '';
    this.connected = true;
    sock.on('error', () => undefined); // reported through 'close'
    sock.on('close', (hadError: boolean) => this.onSocketClose(hadError ? new Error('socket error') : null));
  }

  /** Action: Login. True on `Response: Success`. */
  async login(username: string, secret: string, timeout = AMI_TIMEOUT): Promise<{ ok: boolean; reply: string }> {
    const reply = await this.send('Login', { Username: username, Secret: secret }, timeout);
    return { ok: !!reply && /Response:\s*Success/i.test(reply), reply: reply || '' };
  }

  /**
   * Send a single-reply action and wait for its Response (raw text, without the trailing
   * blank line), or null on timeout / closed connection.
   */
  async send(action: string, params: Record<string, unknown> | null = null, timeout = AMI_TIMEOUT): Promise<string | null> {
    const msgs = await this.request(action, params, null, timeout);
    return msgs && msgs.length ? msgs[0] : null;
  }

  /**
   * Send a list action and collect its reply: [response, ...events, completeEvent].
   * Resolves with what arrived so far on timeout (so a slow PBX still yields the members
   * it managed to list), or null if not even the response came.
   */
  async sendList(
    action: string,
    params: Record<string, unknown> | null = null,
    completeEvent: string | null = null,
    timeout = AMI_LIST_TIMEOUT,
  ): Promise<string[] | null> {
    return this.request(action, params, completeEvent || `${action}Complete`, timeout);
  }

  private request(
    action: string,
    params: Record<string, unknown> | null,
    completeEvent: string | null,
    timeout: number,
  ): Promise<string[] | null> {
    const sock = this.sock;
    if (!this.connected || !sock || sock.destroyed) return Promise.resolve(null);
    if (!amiActionAllowed(action, params)) {
      refused(`AMI action ${action}`);
      return Promise.resolve(null);
    }
    this.counter += 1;
    const actionId = `${this.prefix}-${process.pid}-${this.counter}`;
    return new Promise<string[] | null>((resolve) => {
      const entry: PendingAction = {
        action,
        completeEvent,
        raw: [],
        gotResponse: false,
        timer: setTimeout(() => {
          this.pending.delete(actionId);
          resolve(entry.raw.length ? entry.raw : null);
        }, timeout * 1000),
        resolve,
      };
      this.pending.set(actionId, entry);
      try {
        sock.write(renderAction(action, actionId, params));
      } catch {
        clearTimeout(entry.timer);
        this.pending.delete(actionId);
        resolve(null);
      }
    });
  }

  /** Fire-and-forget write (Logoff). */
  write(action: string, params: Record<string, unknown> | null = null): void {
    if (!this.sock || this.sock.destroyed) return;
    if (!amiActionAllowed(action, params)) {
      refused(`AMI action ${action}`);
      return;
    }
    try {
      this.sock.write(renderAction(action, null, params));
    } catch {
      // closing
    }
  }

  /** Close the socket; pending actions resolve with what they have (or null). */
  close(): Promise<void> {
    const sock = this.sock;
    if (!sock) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (sock.destroyed) {
        resolve();
        return;
      }
      sock.once('close', () => resolve());
      sock.end(() => sock.destroy());
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 1000).unref();
    });
  }

  private onData(d: Buffer): void {
    // errors='ignore': a split multi-byte sequence or stray byte must not kill the feed.
    for (const msg of this.framer.feed(d.toString('utf8').replace(/�/g, ''))) this.route(msg);
  }

  /** Route one framed message to its pending action or to the event feed. */
  route(msg: string): void {
    const head = parse(msg);
    const actionId = head['ActionID'] || '';
    const entry = actionId ? this.pending.get(actionId) : undefined;
    if ('Response' in head) {
      if (!entry) return; // stale / foreign reply
      entry.raw.push(msg);
      entry.gotResponse = true;
      const isList = entry.completeEvent !== null;
      const failed = !/^(Success|Follows)$/i.test(head['Response'] || '');
      // A list action that failed (or a PBX that answered without starting a list) ends here.
      const listStarted = /start/i.test(head['EventList'] || '') || /will follow/i.test(head['Message'] || '');
      if (!isList || failed || !listStarted) this.finish(actionId, entry);
      return;
    }
    if ('Event' in head) {
      if (entry && entry.completeEvent !== null) {
        entry.raw.push(msg);
        if (head['Event'] === entry.completeEvent || /complete/i.test(head['EventList'] || '')) {
          this.finish(actionId, entry);
        }
        return;
      }
      // List events whose action already timed out: ours, not live events.
      if (actionId.startsWith(`${this.prefix}-`)) return;
      this.opts.onEvent?.(msg);
    }
  }

  private finish(actionId: string, entry: PendingAction): void {
    clearTimeout(entry.timer);
    this.pending.delete(actionId);
    entry.resolve(entry.raw);
  }

  private onSocketClose(err: Error | null): void {
    if (!this.connected && !this.pending.size) {
      this.sock = null;
      return;
    }
    this.connected = false;
    this.sock = null;
    for (const [id, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(entry.raw.length ? entry.raw : null);
    }
    this.opts.onClose?.(err);
  }
}
