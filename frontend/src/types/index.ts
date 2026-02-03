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
  type: 'state_update' | 'initial_state' | 'action_result' | 'error';
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

