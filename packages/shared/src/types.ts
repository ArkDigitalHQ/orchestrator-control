// ─── Session ──────────────────────────────────────────────────────────────────

export type SessionStatus = "idle" | "running" | "awaiting" | "errored" | "stopped";
export type AwaitingKind = "prompt" | "permission";

export interface Session {
  id: string;
  machine_id: string;
  sdk_session_id: string | null;
  project_path: string | null;
  status: SessionStatus;
  awaiting: AwaitingKind | null;
  awaiting_detail: unknown | null;
  last_message: string | null;
  last_event_at: string;
  created_at: string;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export type CommandType = "prompt" | "permission_decision" | "interrupt" | "close" | "set_permission_mode";
export type CommandStatus = "pending" | "delivered" | "acked" | "executed" | "failed" | "expired";

export interface Command {
  id: string;
  machine_id: string;
  session_id: string | null;
  command_type: CommandType;
  payload: unknown;
  status: CommandStatus;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  result: unknown | null;
}

// ─── WebSocket messages: Supervisor → Control Plane ───────────────────────────

export interface WsConnectMsg {
  type: "connect";
  machine_id: string;
  sdk_session_id: string | null;
  project_path: string | null;
}

export interface WsHeartbeatMsg {
  type: "heartbeat";
  machine_id: string;
  timestamp: string;
}

export interface WsSessionStartMsg {
  type: "session_start";
  machine_id: string;
  sdk_session_id: string;
  project_path: string;
}

export interface WsSessionEndMsg {
  type: "session_end";
  machine_id: string;
  sdk_session_id: string;
  total_cost_usd: number;
  total_turns: number;
}

export interface WsStatusUpdateMsg {
  type: "status_update";
  machine_id: string;
  status: SessionStatus;
  awaiting: AwaitingKind | null;
  awaiting_detail: unknown | null;
  last_message: string | null;
}

export interface WsPermissionRequestMsg {
  type: "permission_request";
  machine_id: string;
  decision_id: string;
  tool_name: string;
  tool_input: unknown;
}

export interface WsAckMsg {
  type: "ack";
  command_id: string;
  phase: "received" | "executed" | "failed";
  error?: string;
}

export type SupervisorMessage =
  | WsConnectMsg
  | WsHeartbeatMsg
  | WsSessionStartMsg
  | WsSessionEndMsg
  | WsStatusUpdateMsg
  | WsPermissionRequestMsg
  | WsAckMsg;

// ─── WebSocket messages: Control Plane → Supervisor ───────────────────────────

export interface CpCommandMsg {
  type: "command";
  command_id: string;
  command_type: CommandType;
  payload: unknown;
}

export type ControlPlaneMessage = CpCommandMsg;

// ─── Permission decision payload ──────────────────────────────────────────────

export interface PermissionDecisionPayload {
  decision_id: string;
  decision: "allow" | "deny";
  message?: string;
}
