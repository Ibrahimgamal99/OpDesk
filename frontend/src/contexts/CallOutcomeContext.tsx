import { createContext, useContext } from 'react';

/**
 * The status of the current user's last finished call, as the backend decided it at
 * hangup (WebSocket `call_outcome`, one of the ten statuses in components/callStatus.ts).
 *
 * `seq` is bumped on every frame, monotonically, so a consumer keyed on it reacts to two
 * identical outcomes in a row (two Busy calls must both show), which comparing the status
 * alone would swallow.
 */
export interface CallOutcome {
  status: string;
  linkedid: string;
  seq: number;
}

const CallOutcomeContext = createContext<CallOutcome | null>(null);

export const CallOutcomeProvider = CallOutcomeContext.Provider;

export function useCallOutcome(): CallOutcome | null {
  return useContext(CallOutcomeContext);
}
