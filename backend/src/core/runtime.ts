/**
 * The live singletons, built at startup and shared by every module (the module globals of
 * server.py: monitor, bridge, crm_connector, contact_resolver, _pre_woken, ...).
 *
 * Always read them through the object: `import { runtime } from '../core/runtime'`, then
 * `runtime.monitor`. The lifespan rebinds most of them after import, so copying one into a
 * local at import time would keep the null it started with.
 */

import { ConnectionManager } from './ws-manager';
import type { CRMConnector } from '../integrations/crm';
import type { ContactResolver } from '../integrations/crm-lookup';
import type { AgentStateManager } from '../services/agent-state';
import type { AMIExtensionsMonitor } from '../services/ami';

/**
 * The AMI -> WebSocket bridge (server.py AMIEventBridge): the 100 ms state broadcast loop.
 * Whoever implements it assigns it here; REST handlers call broadcastStateNow() after a
 * mutating action so every panel updates at once.
 */
export interface LiveStateBridge {
  /** The (optionally filtered) live state snapshot; null lists = unfiltered. */
  getCurrentState(allowExtensions?: string[] | null, allowQueues?: string[] | null): Record<string, unknown> | Promise<Record<string, unknown>>;
  broadcastStateNow(): Promise<void>;
  stop(): Promise<void>;
  [key: string]: unknown;
}

export interface Runtime {
  manager: ConnectionManager;
  monitor: AMIExtensionsMonitor | null;
  bridge: LiveStateBridge | null;
  agentState: AgentStateManager | null;
  crmConnector: CRMConnector | null;
  /**
   * Contact-name resolution (phonebook + optional CRM lookup). Constructed at startup and
   * inert until it gets a usable config.
   */
  contactResolver: ContactResolver | null;
  crmLookupConnector: CRMConnector | null;
  /**
   * The RFC 8599 SIP push module once started (services/sip-push). Typed loosely: callers that
   * need its functions import the module itself; this slot only says whether it is running.
   */
  sipPush: Record<string, unknown> | null;
  /** agent_presence.PresenceRecorder once started. */
  presence: unknown;
  /**
   * Extensions that received a predial wake push, keyed by extension -> monotonic(). The
   * incoming-call callback suppresses a second push while the entry is fresh (12 s), so the
   * phone gets one push per call.
   */
  preWoken: Map<string, number>;
  /** Extension -> monotonic() of its last "registered and ready" report. */
  wakeReadyAt: Map<string, number>;
}

export const runtime: Runtime = {
  manager: new ConnectionManager(),
  monitor: null,
  bridge: null,
  agentState: null,
  crmConnector: null,
  contactResolver: null,
  crmLookupConnector: null,
  sipPush: null,
  presence: null,
  preWoken: new Map(),
  wakeReadyAt: new Map(),
};
