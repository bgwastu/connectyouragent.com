export interface MsgJoin {
  type: "join";
  session: string;
  role: "agent";
  meta: AgentMeta;
}

export interface AgentMeta {
  host: string;
}

export interface MsgCommand {
  type: "command";
  cmd: string;
  id?: string;
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

export type ProtocolMsg = MsgJoin | MsgCommand | MsgOutput | MsgCommandResult | MsgError | MsgBye;

export interface SessionInfo {
  code: string;
  status: "waiting" | "active" | "closed";
  host: string;
  created_at: string;
}

export interface CommandResult {
  output: string;
  exit_code: number;
}

export function parseMessage(raw: string): ProtocolMsg | null {
  try {
    return JSON.parse(raw) as ProtocolMsg;
  } catch {
    return null;
  }
}
