import type { ServerWebSocket } from "bun";
import type { CommandResult, ProtocolMsg } from "./protocol.ts";
import { parseMessage } from "./protocol.ts";
import * as store from "./store.ts";

export const isSessionCode = store.isSessionCode;

export function handleJoin(ws: ServerWebSocket<unknown>, msg: Extract<ProtocolMsg, { type: "join" }>) {
  if (!isSessionCode(msg.session)) {
    rejectJoin(ws, "Invalid join request");
    return;
  }

  const session = store.get(msg.session);
  if (!session || session.status === "closed") {
    rejectJoin(ws, "Session not found or closed");
    return;
  }

  if (session.agent) {
    rejectJoin(ws, "Agent already connected");
    return;
  }

  store.setActive(msg.session, msg.meta.host, ws);
  ws.send(JSON.stringify({ type: "output", data: `Joined session ${msg.session}\n` }));
}

export function handleMessage(ws: ServerWebSocket<unknown>, raw: string) {
  const msg = parseMessage(raw);
  if (!msg) return;

  if (msg.type !== "command_result") return;

  // Find the session this agent belongs to
  for (const [, session] of store.all()) {
    if (session.agent === ws) {
      const pending = session.pendingHttp.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pendingHttp.delete(msg.id);
      pending.resolve({ output: msg.output, exit_code: msg.exit_code });
      return;
    }
  }
}

export function handleDisconnect(ws: ServerWebSocket<unknown>) {
  for (const [code, session] of store.all()) {
    if (session.agent === ws) {
      store.disconnect(code);
      return;
    }
  }
}

export function executeHttpCommand(code: string, cmd: string, timeoutSec?: number): Promise<CommandResult> {
  const session = store.get(code);
  if (!session) return Promise.reject(new Error("Session not found"));
  if (!session.agent) return Promise.reject(new Error("Agent not connected"));

  const id = crypto.randomUUID();
  const timeoutMs = Math.max(1000, Math.min((timeoutSec ?? 30) * 1000, 300_000));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingHttp.delete(id);
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    session.pendingHttp.set(id, { resolve, reject, timer });
    session.agent!.send(JSON.stringify({ type: "command", cmd, id }));
    store.touch(code);
  });
}

function rejectJoin(ws: ServerWebSocket<unknown>, message: string) {
  ws.send(JSON.stringify({ type: "error", message }));
  ws.close();
}
