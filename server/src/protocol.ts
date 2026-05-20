export type Role = "agent" | "client";

export interface MsgJoin {
  type: "join";
  session: string;
  role: Role;
  meta?: AgentMeta;
}

export interface AgentMeta {
  os: string;
  arch: string;
  host: string;
  user: string;
  cwd?: string;
  shell?: string;
  elevated?: boolean;
}

export interface MsgCommand {
  type: "command";
  cmd: string;
  id?: string; // for HTTP correlation
}

export interface MsgInput {
  type: "input";
  data: string;
  encoding?: "utf8" | "base64";
}

export interface MsgResize {
  type: "resize";
  cols: number;
  rows: number;
}

export interface MsgSignal {
  type: "signal";
  name: "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP" | "SIGQUIT";
}

export interface MsgOutput {
  type: "output";
  data: string;
  encoding?: "utf8" | "base64";
  id?: string;
}

export interface MsgCommandResult {
  type: "command_result";
  id: string;
  output: string;
  exit_code: number;
}

export interface MsgError {
  type: "error";
  message: string;
}

export interface MsgBye {
  type: "bye";
  reason?: string;
}

export type ProtocolMsg = MsgJoin | MsgCommand | MsgInput | MsgResize | MsgSignal | MsgOutput | MsgCommandResult | MsgError | MsgBye;

export interface SessionInfo {
  code: string;
  status: "waiting" | "active" | "closed";
  agent_os?: string;
  agent_arch?: string;
  agent_host?: string;
  agent_user?: string;
  agent_cwd?: string;
  agent_shell?: string;
  created_at: string;
}

export interface CommandResult {
  output: string;
  exit_code: number;
}
