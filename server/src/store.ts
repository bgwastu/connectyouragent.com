import type { ServerWebSocket } from "bun";
import type { AgentMeta, CommandResult } from "./protocol.ts";

export type SessionStatus = "waiting" | "active" | "closed";

type PendingCommand = {
  resolve: (value: CommandResult) => void;
  reject: (error: Error) => void;
  timer: Timer;
};

export interface Meta {
  host: string;
  os: string;
  arch: string;
  user: string;
  cwd: string;
  shell: string;
  elevated: boolean;
}

export interface Session {
  code: string;
  status: SessionStatus;
  meta: Meta;
  createdAt: number;
  lastActivity: number;
  agent: ServerWebSocket<unknown> | null;
  pendingHttp: Map<string, PendingCommand>;
}

const sessions = new Map<string, Session>();

export function isSessionCode(value: string): boolean {
  return /^[0-9a-f]{12}$/.test(value);
}

const emptyMeta: Meta = { host: "", os: "", arch: "", user: "", cwd: "", shell: "", elevated: false };

export function create(code: string): Session {
  const now = Date.now();
  const session: Session = {
    code,
    status: "waiting",
    meta: { ...emptyMeta },
    createdAt: now,
    lastActivity: now,
    agent: null,
    pendingHttp: new Map(),
  };
  sessions.set(code, session);
  return session;
}

export function get(code: string): Session | undefined {
  return sessions.get(code);
}

export function all(): ReadonlyMap<string, Session> {
  return sessions;
}

export function list(): { code: string; status: SessionStatus; host: string; created_at: string }[] {
  const results: { code: string; status: SessionStatus; host: string; created_at: string }[] = [];
  for (const [, s] of sessions) {
    if (s.status === "closed") continue;
    results.push({
      code: s.code,
      status: s.status,
      host: s.meta.host,
      created_at: new Date(s.createdAt).toISOString(),
    });
  }
  results.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return results;
}

export function setActive(code: string, meta: AgentMeta, ws: ServerWebSocket<unknown>) {
  const session = sessions.get(code);
  if (!session) return;
  session.status = "active";
  session.meta = {
    host: meta.host,
    os: meta.os,
    arch: meta.arch,
    user: meta.user,
    cwd: meta.cwd || "",
    shell: meta.shell || "",
    elevated: meta.elevated || false,
  };
  session.agent = ws;
  session.lastActivity = Date.now();
}

export function disconnect(code: string) {
  const session = sessions.get(code);
  if (!session) return;
  session.status = "waiting";
  session.agent = null;
  session.lastActivity = Date.now();
}

export function close(code: string) {
  const session = sessions.get(code);
  if (!session) return;

  for (const pending of session.pendingHttp.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Session closed"));
  }
  session.pendingHttp.clear();

  session.agent?.close();
  sessions.delete(code);
}

export function touch(code: string) {
  const session = sessions.get(code);
  if (session) session.lastActivity = Date.now();
}

export function cleanup(idleSeconds: number): string[] {
  const now = Date.now();
  const closed: string[] = [];
  for (const [code, session] of sessions) {
    const idle = (now - session.lastActivity) / 1000;
    if (!session.agent && idle > idleSeconds) {
      close(code);
      closed.push(code);
    }
  }
  return closed;
}
