import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../auth';
import type { PauseReason } from '../types';

/**
 * The admin-managed Not-Ready reason list, plus a code -> label resolver.
 *
 * The live presence (`agent_states`) and the queue members carry the reason CODE only.
 * The label is display data, so it is resolved here, next to the picker that already
 * needs this list: renaming a reason shows at once everywhere, with no state change.
 *
 * `labelFor` falls back to the raw code: an agent paused under a reason that was since
 * deleted should still render as something, not blank. The `__WRAPUP` system reason is
 * named even when the list excludes system rows.
 *
 * Options mirror `GET /api/pause-reasons`: `activeOnly` hides retired codes and
 * `includeSystem` adds the system rows (admins only; the server ignores it for others).
 */
export function usePauseReasons(opts: { activeOnly?: boolean; includeSystem?: boolean } = {}) {
  const { activeOnly = true, includeSystem = false } = opts;
  const { t } = useTranslation();
  const [reasons, setReasons] = useState<PauseReason[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (activeOnly) params.set('active_only', 'true');
    if (includeSystem) params.set('include_system', 'true');
    const qs = params.toString();
    fetchWithAuth(`/api/pause-reasons${qs ? `?${qs}` : ''}`)
      .then((r) => (r.ok ? r.json() : { reasons: [] }))
      .then((d) => { if (alive) setReasons(Array.isArray(d.reasons) ? d.reasons : []); })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [activeOnly, includeSystem, version]);

  // Stable between renders, so a list that resolves labels in a useMemo does not recompute
  // on every render.
  const labelFor = useCallback((code?: string | null): string | null => {
    if (!code) return null;
    const hit = reasons.find((r) => r.code === code);
    if (hit) return hit.label;
    if (code === WRAPUP_REASON) return t('agent.state.wrapUp', 'Wrap-up');
    return code;
  }, [reasons, t]);

  /** Reasons an agent may pick: active and not system-owned. */
  const selectable = useMemo(() => reasons.filter((r) => !!r.is_active && !r.is_system), [reasons]);

  return { reasons, selectable, loaded, labelFor, reload: () => setVersion((v) => v + 1) };
}

/** The system reason the backend pauses an agent under while they wrap a call up. */
export const WRAPUP_REASON = '__WRAPUP';
