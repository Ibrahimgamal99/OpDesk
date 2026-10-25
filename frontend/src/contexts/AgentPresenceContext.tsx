import { createContext, useContext } from 'react';
import type { AgentStateInfo, ActionMessage } from '../types';

/**
 * The current user's live agent presence, plus the way to change it, for any component
 * (the softphone's status bar, the header). Presence comes from the WebSocket
 * `agent_states` payload; actions (`agent_login`, `agent_logout`, `agent_set_status`,
 * `agent_wrapup_done`) go back over the same socket via `sendAction`.
 */
export interface AgentPresenceValue {
  /** The current user's extension, or null if they have none. */
  myExt: string | null;
  /** True if this extension is a queue agent (full Ready/Not-Ready band); false for a
   *  plain extension, which gets Available/DND/Offline only. */
  isAgent: boolean;
  /** The current user's live presence, or null when logged out / unknown. */
  presence: AgentStateInfo | null;
  /** The extension's DND flag from the live extension state. */
  dnd: boolean;
  /** True while the extension is ringing, dialing or in a call. */
  onCall: boolean;
  /** Send a WebSocket action (same channel as operator actions). */
  sendAction: (action: ActionMessage) => void;
}

const AgentPresenceContext = createContext<AgentPresenceValue>({
  myExt: null,
  isAgent: false,
  presence: null,
  dnd: false,
  onCall: false,
  sendAction: () => {},
});

export const AgentPresenceProvider = AgentPresenceContext.Provider;

export function useAgentPresence(): AgentPresenceValue {
  return useContext(AgentPresenceContext);
}
