// Extension status types
export type ExtensionStatus = 
  | 'idle' 
  | 'ringing' 
  | 'in_call' 
  | 'dialing' 
  | 'unavailable' 
  | 'on_hold';

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
}

export interface Stats {
  total_extensions: number;
  active_calls_count: number;
  total_queues: number;
  total_waiting: number;
}

/** One row of the Agent Adherence report. */
export interface AgentAdherenceRow {
  agent: string;
  name: string;
  login: string | null;      // ISO, or null if no activity
  logout: string | null;     // ISO, or null if still logged in
  logged_in: boolean;        // true = currently logged in
  logged_in_secs: number;
  ready_secs: number;
  on_call_secs: number;
  wrap_secs: number;
  not_ready_secs: number;
  productive_not_ready_secs: number;
  occupancy_pct: number;
  not_ready_breakdown: { code: string; label: string; productive: boolean; secs: number }[];
}

export interface AppState {
  extensions: Record<string, Extension>;
  active_calls: Record<string, CallInfo>;
  queues: Record<string, Queue>;
  queue_members: Record<string, QueueMember>;
  queue_entries: Record<string, QueueEntry>;
  stats: Stats;
}

export interface WebSocketMessage {
  type: 'state_update' | 'initial_state' | 'action_result' | 'error' | 'call_notification_new';
  data?: AppState;
  timestamp?: string;
  action?: string;
  success?: boolean;
  message?: string;
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
  extension: string | null;
  call_type: string;
  recording_path: string | null;
  recording_file: string | null;
  app: string;
  call_journey_count?: number | null;
  linkedid?: string | null;
  uniqueid?: string | null;
  // Supervision (listen/whisper/barge). `is_supervision` marks the standalone ChanSpy
  // row (hidden by default in the UI); `supervision` carries the spy metadata.
  is_supervision?: boolean;
  supervision?: CallSupervisionInfo | null;
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
  time: string;
  agent?: string;
  duration?: number;
  reason?: string;
  from_number?: string;
  to_number?: string;
  queue?: string;
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
  answer_rate: number | null;
  sum_billsec: number;
}

export interface CombinedKpis {
  total_calls: number;
  answered_calls: number;
  aht_secs: number | null;
}

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
  outbound?: OutboundKpis;
  combined?: CombinedKpis;
}

export interface ExecutiveKPIResponse {
  period: AnalyticsPeriod;
  current: KpiSummary;
  prev_period: KpiSummary;
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
}

export interface AgentKPIRow {
  rank: number;
  agent_extension: string;
  agent_name: string;
  total_calls: number;
  answered_calls: number;
  inbound_calls: number;
  outbound_calls: number;
  aht_secs: number | null;
  sla_contribution_pct: number | null;
  daily_trend: number[];
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
  /** 'manual' = admin-created/edited; 'crm' = auto-added by the CRM lookup. */
  source: 'manual' | 'crm';
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
