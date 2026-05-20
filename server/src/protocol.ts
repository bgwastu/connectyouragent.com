export type Role = "agent" | "client";

export interface MsgJoin {
  type: "join";
  session: string;
  role: Role;
}

export interface MsgCommand {
  type: "command";
  cmd: string;
  id?: string; // for HTTP correlation
}

export interface MsgOutput {
  type: "output";
  data: string;
  id?: string;
}

export interface MsgError {
  type: "error";
  message: string;
}

export interface MsgBye {
  type: "bye";
  reason?: string;
}

export type ProtocolMsg = MsgJoin | MsgCommand | MsgOutput | MsgError | MsgBye;

export interface SessionInfo {
  code: string;
  status: "waiting" | "active" | "closed";
  agent_os?: string;
  agent_arch?: string;
  agent_host?: string;
  created_at: string;
}

export interface CommandResult {
  output: string;
  exit_code: number;
}
