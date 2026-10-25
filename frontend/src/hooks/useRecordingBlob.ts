import { useCallback, useEffect, useRef } from 'react';
import { fetchRecordingBlob, RecordingFetchError } from '../auth';

/**
 * Object URLs for recordings, fetched with the Bearer header.
 *
 * `/api/recordings/...` does not accept a token in the query string, so an `<audio src>`
 * or a download link cannot point at it directly. `load` fetches the file once per path,
 * retries once after a network failure, and hands back a blob URL. The hook owns that
 * URL: loading another path, `reset`, or unmounting revokes it, so a table of players
 * does not leak one blob per row.
 *
 * Nothing is fetched until `load` is called (a click on play or download): a page of
 * call history must not download every recording on it.
 */
export function useRecordingBlob() {
  const currentRef = useRef<{ path: string; url: string } | null>(null);
  const inflightRef = useRef<{ path: string; promise: Promise<string> } | null>(null);
  const mountedRef = useRef(true);

  const reset = useCallback(() => {
    inflightRef.current = null;
    if (currentRef.current) URL.revokeObjectURL(currentRef.current.url);
    currentRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reset();
    };
  }, [reset]);

  const load = useCallback((path: string): Promise<string> => {
    if (currentRef.current?.path === path) return Promise.resolve(currentRef.current.url);
    if (inflightRef.current?.path === path) return inflightRef.current.promise;

    // Declared before the body runs so the superseded check below can compare to it.
    let promise: Promise<string> | null = null;
    const run = async (): Promise<string> => {
      let url: string;
      try {
        url = await fetchRecordingBlob(path);
      } catch (e) {
        // Only a dropped connection is worth a second try: a 401 has already signed the
        // user out, and a missing or forbidden file will not change.
        if (!(e instanceof RecordingFetchError) || e.status !== 0) throw e;
        url = await fetchRecordingBlob(path);
      }
      // Superseded (another path, a reset) or unmounted while downloading.
      if (!mountedRef.current || inflightRef.current?.promise !== promise) {
        URL.revokeObjectURL(url);
        throw new Error('recording load superseded');
      }
      inflightRef.current = null;
      if (currentRef.current) URL.revokeObjectURL(currentRef.current.url);
      currentRef.current = { path, url };
      return url;
    };
    const started = run();
    promise = started;
    inflightRef.current = { path, promise: started };
    started.catch(() => {
      if (inflightRef.current?.promise === started) inflightRef.current = null;
    });
    return started;
  }, []);

  return { load, reset };
}

/** Save a loaded recording under `filename` through a throwaway link. */
export function downloadObjectUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}
