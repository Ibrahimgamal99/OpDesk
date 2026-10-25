// Extension status types
export type ExtensionStatus = 
  | 'idle' 
  | 'ringing' 
  | 'in_call' 
  | 'dialing' 
  | 'unavailable' 
  | 'on_hold';

/** Which way a call in progress runs, from its extension's side (null until something marks it). */
export type LiveRoute = 'inbound_queue' | 'inbound_direct' | 'internal' | 'outbound';

export interface CallInfo {
  extension: string;
  state: string;
  talking_to: string;
  /** CRM-resolved name of the remote party ("" when unknown or lookup disabled) */
  contact_name: string;
  duration: string | null;
  talk_time: string | null;
  channel: string;
  caller: string;
  callerid: string;
  destination: string;
  original_destination: string;
  route?: LiveRoute | null;
}

export interface Extension {
  extension: string;
  name?: string;
  status: ExtensionStatus;
  status_code: string;
  dnd?: boolean;
  call_info: CallInfo | null;
}

export interface QueueMember {
  queue: string;
  interface: string;
  membername: string;
  status: string;
  paused: boolean;
  pause_reason?: string;  // Not-Ready reason code/label when paused
  dynamic?: boolean;  // True if added via AMI (can be removed), false/undefined if static (from config)
}

export interface QueueEntry {
  queue: string;
  callerid: string;
  position: number;
  wait_time: string | null;
}

export interface Queue {
  /** Queue identifier (extension) from Asterisk */
  extension?: string;
  /** Display name (from DB or same as extension) */
  name: string;
  members: Record<string, { status: string; paused: boolean; membername: string }>;
  calls_waiting: number;
  /** The queue's service-level target in seconds (analytics settings): a wait past it is late. */
  sla_secs?: number;
}

export interface Stats {
  total_extensions: number;
  active_calls_count: number;
  total_queues: number;
  total_waiting: number;
}

// ── Agent presence (Not-Ready codes) ─────────────────────────────────────────

/** Live agent presence state, as the backend's agent-state manager reports it. */
export type AgentState =
  | 'logged_out'
  | 'ready'
  | 'not_ready'
  | 'on_call'
  | 'wrap_up'
  | 'dnd'
  | 'available';  // non-agent presence (plain extension: reachable, no queue)

/** One agent's live presence, pushed in the WebSocket state payload (`agent_states`).
 *  It carries the reason CODE only; the label is resolved client-side (usePauseReasons). */
export interface AgentStateInfo {
  extension: string;
  state: AgentState;
  reason_code: string | null;
  /** ISO timestamp (with UTC offset) the state was entered, so a timer survives a reload. */
  since: string;
  /** Seconds in the current state at snapshot time. */
  duration_secs: number;
  linkedid: string | null;
  queue: string | null;
  /** False for a plain extension (Available/DND/Offline presence, no queue). */
  is_agent?: boolean;
}

/** An admin-managed Not-Ready / pause reason code. MySQL TINYINTs arrive as 0/1. */
export interface PauseReason {
  id: number;
  code: string;
  label: string;
  productive: number | boolean;
  color?: string | null;
  sort_order: number;
  is_active: number | boolean;
  is_system: number | boolean;
}

/** One row of the Agent Adherence report. */
export interface AgentAdherenceRow {
  agent: string;
  name: string;
  login: string | null;      // ISO, first login of the period
  logout: string | null;     // ISO, or null if still logged in
  logged_in: boolean;        // true = currently logged in
  /** Login sessions in the period (a logout, or the shift boundary, ends one). */
  sessions?: number;
  logged_in_secs: number;    // ready + on call + wrap + not ready + dnd
  ready_secs: number;
  on_call_secs: number;
  wrap_secs: number;
  not_ready_secs: number;    // every paused state with a reason
  /** The unproductive part of not_ready (break, lunch, ...). */
  break_secs?: number;
  dnd_secs?: number;
  productive_not_ready_secs: number;
  occupancy_pct: number;
  not_ready_breakdown: { code: string; label: string; productive: boolean; secs: number }[];
}

/** One presence state an agent held, from GET /api/analytics/agent-adherence/timeline. */
export interface AgentTimelineEntry {
  id: number;
  state: AgentState;
  reason_code: string | null;
  reason_label: string | null;
  queue: string | null;
  source: string | null;     // ui / ami / supervisor / system
  started_at: string;        // ISO, real clock time (may precede the window)
  ended_at: string | null;   // null = still in this state
  open: boolean;
  duration_secs: number;     // time inside the selected window
}

/** One login session: the moves between a login and the logout that ended it. */
export interface AgentTimelineSession {
  login: string;             // ISO
  logout: string | null;     // null = still logged in
  open: boolean;
  /** 'dnd' = the agent ended this shift by going Do Not Disturb rather than logging out. */
  closed_by: 'dnd' | null;
  duration_secs: number;
  entries: AgentTimelineEntry[];
}

export interface AgentTimeline {
  agent: string;
  name: string;
  sessions: AgentTimelineSession[];  // newest first
}

export interface AppState {
  extensions: Record<string, Extension>;
  active_calls: Record<string, CallInfo>;
  queues: Record<string, Queue>;
  queue_members: Record<string, QueueMember>;
  queue_entries: Record<string, QueueEntry>;
  /** Live presence per extension (agent-state manager snapshot, scope-filtered). */
  agent_states?: Record<string, AgentStateInfo>;
  stats: Stats;
}

export interface WebSocketMessage {
  type: 'state_update' | 'initial_state' | 'action_result' | 'error' | 'call_notification_new' | 'call_outcome';
  data?: AppState;
  timestamp?: string;
  action?: string;
  success?: boolean;
  message?: string;
  // call_notification_new / call_outcome: the extension the frame is about.
  extension?: string;
  // call_outcome: the call's status (components/callStatus.ts), pushed at hangup.
  status?: string;
  linkedid?: string;
}

export interface ActionMessage {
  action: string;
  [key: string]: unknown;
}

// Call Log types
export interface CallLogRecord {
  calldate: string;
  src: string;
  dst: string;
  phone_number: string;
  customer_name: string | null;
  duration: number;
  talk: number;
  disposition: string;
  status: string;
  QoS: string | null;
  // The answering agent's extension, and their name as the PBX knows it.
  extension: string | null;
  agent_name?: string | null;
  call_type: string;
  // How the call reached (or left) the agent: inbound_queue, inbound_ivr, inbound_direct,
  // outbound_direct, internal_extension, internal_feature, internal_supervision. Its prefix
  // is the side the call counts on.
  route?: string | null;
  recording_path: string | null;
  recording_file: string | null;
  app: string;
  // Who ended the call, read off the same CEL facts as the journey's HANGUP event.
  // Null when CEL has no say.
  ended_by?: 'agent' | 'customer' | 'system' | null;
  ended_by_agent?: string | null;
  call_journey_count?: number | null;
  linkedid?: string | null;
  uniqueid?: string | null;
  // Supervision (listen/whisper/barge). `is_supervision` marks the standalone ChanSpy
  // row (hidden by default in the UI); `supervision_count` marks a normal call that
  // was monitored (its journey carries the LISTEN/WHISPER/BARGE events).
  is_supervision?: boolean;
  supervision?: CallSupervisionInfo | null;
  supervision_count?: number | null;
}

export interface CallSupervisionInfo {
  mode: 'listen' | 'whisper' | 'barge' | string;
  supervisor_extension?: string | null;
  target_extension?: string | null;
  target_linkedid?: string | null;
}

// Call journey event (from API)
export interface CallJourneyEvent {
  event: string;
  /** Naive server-local ISO `YYYY-MM-DDTHH:MM:SS`; rendered in the viewer's locale. */
  time: string;
  agent?: string;
  duration?: number;
  /** HANGUP: the raw CDR disposition. Not shown: the call status says it better. */
  reason?: string;
  from_number?: string;
  to_number?: string;
  queue?: string;
  supervisor?: string;   // LISTEN/WHISPER/BARGE: the supervising extension
  target?: string;       // LISTEN/WHISPER/BARGE: the monitored extension
  // HANGUP: who ended the call, kept apart from the call status, so an Unanswered call can
  // still say whose hangup it was.
  ended_by?: 'agent' | 'customer' | 'system';
  ended_by_agent?: string;       // the agent's extension, when ended_by is 'agent'
  // IVR: the menu the caller went through, and the key they pressed when known.
  ivr?: string;
  selection?: string;
  [key: string]: unknown;
}

export interface QoSData {
  // Parsed QoS metrics
  rxJitter: number | null;
  txJitter: number | null;
  rxPackets: number | null;
  txPackets: number | null;
  rxLoss: number | null;
  txLoss: number | null;
  rxMes: number | null;
  txMes: number | null;
  rtt: number | null;
  caller: string | null;
  raw: string;
}

// ---------------------------------------------------------------------------
// Analytics types
// ---------------------------------------------------------------------------

export interface AnalyticsPeriod {
  from: string;
  to: string;
}

export interface OutboundKpis {
  total_calls: number;
  answered_calls: number;
  failed_calls: number;
  no_answer_calls: number;
  busy_calls: number;
  aht_secs: number | null;
  sum_billsec: number;
  /** Distinct outside numbers involved / of those, the ones that answered. The
   *  answer_rate is their ratio; contact_rate is answered calls ÷ all calls. */
  customers?: number;
  customers_answered?: number;
  answer_rate?: number | null;
  contact_rate?: number | null;
}

export interface CombinedKpis {
  total_calls: number;
  /** Neither inbound nor outbound: extension to extension, feature codes, audio loopback tests. */
  internal_calls?: number;
  answered_calls: number;
  aht_secs: number | null;
  /** Distinct outside numbers involved / of those, the ones that answered. The
   *  answer_rate is their ratio; contact_rate is answered calls ÷ all calls. */
  customers?: number;
  customers_answered?: number;
  answer_rate?: number | null;
  contact_rate?: number | null;
}

/** One slice of the period's calls from the call history (every inbound call, the direct
 *  ones, internal): the same shape for each, so a rate means the same on every card. */
export interface VolumeKpis {
  total_calls: number;
  answered_calls: number;
  missed_calls: number;
  aht_secs: number | null;
  sum_billsec: number;
  customers: number;
  customers_answered: number;
  answer_rate: number | null;
  contact_rate: number | null;
}

/** The thresholds an overview was computed against, so its explanations quote them. */
export interface AnalyticsKpiSettings {
  sla_default_secs: number;
  fcr_window_days: number;
  short_abandon_secs: number;
  callback_window_hours: number;
}

/** The top level is the QUEUE's own figures (queue CDR, as Queue Performance counts
 *  them); call volumes are in the `inbound` / `inbound_direct` / `outbound` / `internal` /
 *  `combined` blocks (call history, as Call History counts them). */
export interface KpiSummary {
  sla_pct: number | null;
  fcr_pct: number | null;
  abandonment_rate: number | null;
  short_abandon_rate: number | null;
  aht_secs: number | null;
  total_calls: number;
  answered_calls: number;
  abandoned_calls: number;
  avg_wait_secs: number | null;
  /** Distinct outside numbers involved / of those, the ones that answered. The
   *  answer_rate is their ratio; contact_rate is answered calls ÷ all calls. */
  customers?: number;
  customers_answered?: number;
  answer_rate?: number | null;
  contact_rate?: number | null;
  outbound?: OutboundKpis;
  combined?: CombinedKpis;
  inbound?: VolumeKpis;
  inbound_direct?: VolumeKpis;
  internal?: VolumeKpis;
  short_abandoned?: number;
  /** FCR's population: callers answered in the period, those with a repeat contact, and
   *  whether the window is still open on the newest of them. */
  fcr_callers?: number;
  fcr_repeat_callers?: number;
  fcr_provisional?: boolean;
  /** Callers who gave up in a queue, and those an agent rang back within the callback window. */
  abandoned_callers?: number;
  recovered_callers?: number;
  recovery_rate?: number | null;
  net_abandonment_rate?: number | null;
}

export interface ExecutiveKPIResponse {
  period: AnalyticsPeriod;
  current: KpiSummary;
  /** Null past 31 days: a wide range gets no comparison. */
  prev_period: KpiSummary | null;
  settings?: AnalyticsKpiSettings;
}

/** One day of one queue, for the Queues tab's detail chart. */
export interface QueueDay {
  date: string;
  offered: number;
  answered: number;
  abandoned: number;
}

/** One wait-time bucket of one queue: [from_secs, to_secs), to_secs null = open-ended. */
export interface QueueWaitBucket {
  from_secs: number;
  to_secs: number | null;
  answered: number;
  abandoned: number;
}

export interface QueueKPIRow {
  queue_extension: string;
  queue_name: string;
  total_calls: number;
  answered_calls: number;
  abandoned_calls: number;
  sla_pct: number | null;
  aht_secs: number | null;
  avg_wait_secs: number | null;
  peak_hour: number | null;
  answer_rate?: number | null;
  abandonment_rate?: number | null;
  short_abandon_rate?: number | null;
  daily?: QueueDay[];
  wait_distribution?: QueueWaitBucket[];
}

export interface AgentKPIRow {
  rank: number;
  agent_extension: string;
  agent_name: string;
  /** Customer calls (inbound + outbound); internal calls are counted apart. */
  total_calls: number;
  answered_calls: number;
  inbound_calls: number;
  outbound_calls: number;
  internal_calls?: number;
  aht_secs: number | null;
  sla_contribution_pct: number | null;
  daily_trend: number[];
}

/** GET /api/analytics/agent-calls: one agent's calls by direction, and the list behind them. */
export interface AgentCallsDirection {
  direction: 'IN' | 'OUT' | 'INTERNAL';
  calls: number;
  answered: number;
  missed: number;
  not_connected: number;
  talk_secs: number;
}

export interface AgentCallRecord {
  calldate: string | null;
  direction: 'IN' | 'OUT' | 'INTERNAL';
  src: string;
  dst: string;
  queue_extension: string;
  agent_extension: string;
  duration: number;
  talk: number;
  /** How the call ended; `agent_status` is the same call from this agent's side. */
  status: string;
  agent_status: string;
  is_handled: boolean;
  linkedid: string;
}

export interface AgentCallsResponse {
  agent: string;
  agent_name: string;
  directions: AgentCallsDirection[];
  status_counts: Record<string, number>;
  calls: AgentCallRecord[];
  total: number;
  page: number;
  page_size: number;
}

export interface HeatmapData {
  matrix: number[][];
  abandoned_matrix: number[][];
  labels: { days: string[]; hours: string[] };
}

export interface VolumeTrendPoint {
  date: string;
  total_calls: number;        // inbound total
  answered_calls: number;     // inbound answered
  abandoned_calls: number;    // inbound abandoned
  outbound_total: number;     // outbound total
  outbound_answered: number;  // outbound answered
  internal_total?: number;    // extension to extension
  customers?: number;         // distinct inbound callers that day
  customers_answered?: number;
}

/** Calls in one hour of the day across the range; the 24 of them sum to the trend. */
export interface HourVolume {
  hour: number;
  inbound: number;
  outbound: number;
  internal: number;
}

/** GET /api/analytics/drilldown?facets=1 adds per-value counts over the whole filtered set. */
export interface AnalyticsDrilldownFacets {
  direction?: Record<string, number>;
  status?: Record<string, number>;
  queue?: Record<string, number>;
  agent?: Record<string, number>;
}

export interface AnalyticsDrilldownRecord {
  calldate: string | null;
  src: string;
  dst: string;
  queue_extension: string;
  agent_extension: string;
  duration: number;
  talk: number;
  disposition: string;
  status: string;
  wait_secs: number;
  sla_met: boolean;
  linkedid: string;
  direction?: string;
}

export interface AnalyticsSettings {
  sla_thresholds: Record<string, number>;
  sla_default_secs: number;
  fcr_window_days: number;
  short_abandon_secs: number;
  callback_window_hours: number;
}


// ---------------------------------------------------------------------------
// Logs page
// ---------------------------------------------------------------------------

/** One buffered Asterisk Manager Interface event (System Logs tab). */
export interface AmiEvent {
  seq: number;
  event: string;
  ts: number;              // epoch seconds
  summary: string;
  fields: Record<string, string>;
}

/** A CRM webhook delivery attempt — list row. Bodies are excluded so the table stays light. */
export interface WebhookDelivery {
  id: number;
  created_at: string;
  call_id?: string | null;
  uniqueid?: string | null;
  caller?: string | null;
  destination?: string | null;
  call_type?: string | null;
  call_status?: string | null;
  method: string;
  url: string;             // already redacted server-side (no query string, no userinfo)
  status_code?: number | null;
  success: boolean;
  error?: string | null;
  duration_ms?: number | null;
  attempt: number;
  parent_id?: number | null;
  resent_by?: number | null;
  truncated: boolean;      // request body was clipped when logged => not resendable
  /** pending (retries due) | delivered | failed (rejected) | abandoned (retries spent). */
  status?: WebhookDeliveryStatus;
  attempts?: number;       // sends of this delivery so far
  max_attempts?: number;   // its retry budget
  next_attempt_at?: string | null;
  delivered_at?: string | null;
  trigger_kind?: string | null;   // hangup | wrapup | resend
  delivery_uuid?: string | null;  // the Idempotency-Key every attempt carries
  endpoint_path?: string | null;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

/** Per-value counts of the deliveries list's filters under the current query. */
export interface WebhookDeliveryFacets {
  status: Partial<Record<WebhookDeliveryStatus, number>>;
  call_type: Record<string, number>;
}

/** Full delivery row, fetched lazily when a row is expanded. */
export interface WebhookDeliveryDetail extends WebhookDelivery {
  request_body?: string | null;
  response_body?: string | null;
}

// ---------------------------------------------------------------------------
// Contacts (system phonebook)
// ---------------------------------------------------------------------------
export interface Contact {
  id: number;
  name: string;
  phone: string;        // display form (as entered / as dialed)
  phone_key: string;    // normalized digits (match key)
  company?: string | null;
  notes?: string | null;
  /**
   * Precedence, highest first: 'manual' = admin-created/edited; 'api' = pushed by an
   * external system over an API key; 'crm' = auto-added by the CRM lookup.
   */
  source: 'manual' | 'api' | 'crm';
  /** The pushing system's own id for this contact, and which system that is. */
  external_id?: string | null;
  source_system?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
export interface ApiKey {
  id: number;
  name: string;
  key_prefix: string;
  scopes: string[];
  enabled: number | boolean;   // MySQL returns 1/0
  created_by?: number | null;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
  /** Present ONLY in the POST /api/api-keys response — the one-time plaintext (opd_…). */
  key?: string;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
/** One row of the append-only audit log (every admin-side change). */
export interface AuditLogEntry {
  id: number;
  actor_user_id?: number | null;
  /** The signed-in user's name (or the API key's name) at the time of the change. */
  actor?: string | null;
  actor_ext?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  summary?: string | null;
  ip?: string | null;
  created_at?: string | null;
  /**
   * What the change carried, when the route recorded it (secrets already masked by the
   * server): any JSON value, or the raw text when it was not JSON.
   */
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// Call notifications (the bell)
// ---------------------------------------------------------------------------
export interface CallNotification {
  id: number;
  extension: string;
  caller_from: string | null;
  queue: string | null;
  status_flag: string;
  event_time: string;
  /** A call status (components/callStatus.ts); anything else passes through raw. */
  reason: string | null;
}
