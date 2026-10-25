/**
 * A length of time as a clock: `mm:ss`, or `hh:mm:ss` from one hour up.
 *
 * The one duration format outside Analytics. Live call timers arrive from the
 * backend already in this shape (event-bridge `formatSince`), so the agent's own
 * state timer, the Agents board, Call history and Recordings use it too and a
 * duration reads the same on every page. Render it in `.u-mono` so a column of
 * them lines up.
 */
export function fmtTimer(secs: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** A file size: `512 B`, `1.2 MB`. The Recordings page and the recording storage card. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * The reverse of fmtTimer: "HH:MM:SS" or "MM:SS" (the backend's live wait/duration
 * clocks) back to seconds, so a live figure can be compared, summed or re-rendered
 * through fmtTimer. Anything unparseable reads as 0.
 */
export function parseClock(s: string | null | undefined): number {
  if (!s) return 0;
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * A call's date and time, short ("21 Oct, 14:05"), in the app's language rather than the
 * browser's -- an Arabic UI on an English browser otherwise mixes the two.
 */
export function fmtDateTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale || undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
