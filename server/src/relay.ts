import type { ServerWebSocket } from "bun";
import type { ProtocolMsg, Role } from "./protocol.ts";
import { audit, updateSessionStatus, setAgentMeta, closeSession } from "./db.ts";
import { SESSION_MAX_AGE } from "./config.ts";

interface SessionSlot {
  code: string;
  agent?: ServerWebSocket<unknown>;
  client?: ServerWebSocket<unknown>;
  pendingHttp: Map<string, { resolve: (v: { output: string; exit_code: number }) => void; reject: (e: Error) => void; buffer: string; delimiter: string }>;
  createdAt: number;
  lastActivity: number;
}

const sessions = new Map<string, SessionSlot>();

export function getOrCreateSlot(code: string): SessionSlot {
  let slot = sessions.get(code);
  if (!slot) {
    slot = { code, pendingHttp: new Map(), createdAt: Date.now(), lastActivity: Date.now() };
    sessions.set(code, slot);
  }
  return slot;
}

export function removeSlot(code: string) {
  const slot = sessions.get(code);
  if (!slot) return;
  // Close any pending HTTP requests
  for (const [id, req] of slot.pendingHttp) {
    req.reject(new Error("Session closed"));
  }
  slot.pendingHttp.clear();
  sessions.delete(code);
  closeSession(code);
}

export function handleJoin(ws: ServerWebSocket<unknown>, msg: Extract<ProtocolMsg, { type: "join" }>) {
  const slot = getOrCreateSlot(msg.session);
  ws.data = { session: msg.session, role: msg.role } as any;

  if (msg.role === "agent") {
    if (slot.agent) {
      ws.send(JSON.stringify({ type: "error", message: "Agent already connected" }));
      ws.close();
      return;
    }
    slot.agent = ws;
    updateSessionStatus(msg.session, "active");
    audit(msg.session, "agent", "connected");
    // Inform client if present
    if (slot.client) {
      slot.client.send(JSON.stringify({ type: "output", data: "[Agent connected]\n" }));
    }
  } else if (msg.role === "client") {
    if (slot.client) {
      ws.send(JSON.stringify({ type: "error", message: "Client already connected" }));
      ws.close();
      return;
    }
    slot.client = ws;
    audit(msg.session, "client", "connected");
    // Inform agent if present
    if (slot.agent) {
      slot.agent.send(JSON.stringify({ type: "output", data: "[Client connected]\n" }));
    }
  }

  ws.send(JSON.stringify({ type: "output", data: `Joined session ${msg.session} as ${msg.role}\n` }));
}

export function handleMessage(ws: ServerWebSocket<unknown>, raw: string) {
  const data = ws.data as { session: string; role: Role };
  const slot = sessions.get(data.session);
  if (!slot) return;
  slot.lastActivity = Date.now();

  let msg: ProtocolMsg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "command" && data.role === "client") {
    // Forward command to agent
    if (slot.agent) {
      slot.agent.send(raw);
      audit(data.session, "client", "command", msg.cmd);
    } else {
      ws.send(JSON.stringify({ type: "error", message: "Agent not connected" }));
    }
    return;
  }

  if (msg.type === "output" && data.role === "agent") {
    // Check for HTTP delimiter first
    for (const [id, req] of slot.pendingHttp) {
      if (msg.data.includes(req.delimiter)) {
        const parts = msg.data.split(req.delimiter);
        const output = req.buffer + parts[0];
        const rest = parts.slice(1).join(req.delimiter);
        // Extract exit code from last line of the remaining
        const lines = rest.split("\n");
        const exitCode = parseInt(lines[0], 10) || 0;
        req.resolve({ output, exit_code: exitCode });
        slot.pendingHttp.delete(id);
        // Forward remaining to any WebSocket client
        if (slot.client && lines.length > 1) {
          slot.client.send(JSON.stringify({ type: "output", data: lines.slice(1).join("\n") }));
        }
        return;
      }
      req.buffer += msg.data;
    }

    // Forward to WebSocket client
    if (slot.client) {
      slot.client.send(raw);
    }
    return;
  }

  if (msg.type === "bye") {
    handleDisconnect(ws);
    return;
  }

  // Generic forward for other messages
  const target = data.role === "agent" ? slot.client : slot.agent;
  if (target) target.send(raw);
}

export function handleDisconnect(ws: ServerWebSocket<unknown>) {
  const data = ws.data as { session: string; role: Role } | undefined;
  if (!data) return;
  const slot = sessions.get(data.session);
  if (!slot) return;

  if (data.role === "agent") {
    slot.agent = undefined;
    audit(data.session, "agent", "disconnected");
    if (slot.client) {
      slot.client.send(JSON.stringify({ type: "output", data: "[Agent disconnected]\n" }));
    }
  } else if (data.role === "client") {
    slot.client = undefined;
    audit(data.session, "client", "disconnected");
    if (slot.agent) {
      slot.agent.send(JSON.stringify({ type: "output", data: "[Client disconnected]\n" }));
    }
  }

  // If both sides gone, clean up
  if (!slot.agent && !slot.client && slot.pendingHttp.size === 0) {
    removeSlot(data.session);
  }
}

export function getSlot(code: string) {
  return sessions.get(code);
}

export function executeHttpCommand(code: string, cmd: string): Promise<{ output: string; exit_code: number }> {
  const slot = sessions.get(code);
  if (!slot) return Promise.reject(new Error("Session not found"));
  if (!slot.agent) return Promise.reject(new Error("Agent not connected"));

  const id = crypto.randomUUID();
  const delimiter = `__BRIDGE_DONE__${crypto.randomUUID()}__`;
  const augmentedCmd = `${cmd}; echo "${delimiter}$?"`;

  return new Promise((resolve, reject) => {
    slot.pendingHttp.set(id, { resolve, reject, buffer: "", delimiter });
    slot.agent!.send(JSON.stringify({ type: "command", cmd: augmentedCmd, id }));

    // Timeout
    setTimeout(() => {
      const req = slot.pendingHttp.get(id);
      if (req) {
        req.reject(new Error("Command timed out"));
        slot.pendingHttp.delete(id);
      }
    }, 30000);
  });
}

export function cleanup() {
  const now = Date.now();
  for (const [code, slot] of sessions) {
    const age = (now - slot.createdAt) / 1000;
    const idle = (now - slot.lastActivity) / 1000;
    if (age > SESSION_MAX_AGE || (idle > 600 && slot.status !== "active")) {
      removeSlot(code);
    }
  }
}
