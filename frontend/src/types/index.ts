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
  call_info: CallInfo | null;
}

export interface QueueMember {
  queue: string;
  interface: string;
  membername: string;
  status: string;
  paused: boolean;
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

