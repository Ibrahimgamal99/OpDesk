import { fetchWithAuth } from '../auth';
import { raiseFor } from './api';

/**
 * The filename a response names in `Content-Disposition`, or null when it names none.
 * Handles both `filename="x.csv"` and the RFC 5987 `filename*=UTF-8''x.csv` form.
 */
function dispositionFilename(res: Response): string | null {
  const cd = res.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
  return plain ? plain[1].trim() : null;
}

/** Hand a blob to the browser as a download through a throwaway link. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Download a file from an authenticated endpoint (CSV exports, ...).
 *
 * A plain `<a href>` cannot send the Authorization header, so the file is fetched with
 * it, then saved from a blob. The server's `Content-Disposition` filename wins over
 * `fallbackName`. A failed request throws the server's ApiError, so callers can show
 * its message.
 */
export async function downloadWithAuth(url: string, fallbackName: string, signal?: AbortSignal): Promise<void> {
  const res = await fetchWithAuth(url, { signal });
  if (!res.ok) await raiseFor(res);
  const blob = await res.blob();
  saveBlob(blob, dispositionFilename(res) || fallbackName);
}
