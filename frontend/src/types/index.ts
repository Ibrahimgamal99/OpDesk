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

