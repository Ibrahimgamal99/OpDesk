import { useCallback, useState } from 'react';
import { messageOf } from '../../lib/api';

/**
 * Captures the failure of an async action so it can be shown, instead of it
 * disappearing into `catch { /* ignore *\/ }`.
 *
 * There are two kinds of swallowed failure. Mutation ones are
 * the damaging half — a user clicks Delete, the request 500s, and the row is
 * still there with no indication anything happened, so they click again. The read
 * ones leave an empty table that is indistinguishable from "no results".
 *
 *   const { error, run, clear } = useActionError();
 *   ...
 *   <Alert onDismiss={clear}>{error}</Alert>
 *   <button onClick={() => run(() => apiSend(url, 'DELETE'), t('x.deleteFailed'))}>
 *
 * `run` resolves to `undefined` on failure, so `await`ing it and checking for
 * undefined is enough to skip the success path — no try/catch at the call site.
 */
export function useActionError() {
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => setError(null), []);

  const run = useCallback(async <T,>(
    fn: () => Promise<T>,
    fallback = 'Something went wrong.',
  ): Promise<T | undefined> => {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      // The server's wording wins; `fallback` covers a network drop or a body
      // that carried no message.
      setError(messageOf(e, fallback));
      return undefined;
    }
  }, []);

  return { error, setError, clear, run };
}
