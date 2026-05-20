import { createSession, getSession, listActiveSessions, audit } from "./db.ts";
import { getOrCreateSlot, executeHttpCommand } from "./relay.ts";
import { SESSION_IDLE_TIMEOUT } from "./config.ts";

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function apiHandler(req: Request, url: URL): Response | null {
  const path = url.pathname;
  const method = req.method;

  // POST /api/session — create new session (agent binary calls this on startup)
  if (path === "/api/session" && method === "POST") {
    const code = generateCode();
    createSession(code);
    getOrCreateSlot(code);
    audit(code, "system", "session_created");
    return json({ code, status: "waiting" });
  }

  // GET /api/session/:code
  if (path.startsWith("/api/session/") && method === "GET" && !path.endsWith("/cmd")) {
    const code = path.split("/")[3];
    const session = getSession(code);
    if (!session) return notFound();
    return json({
      code: session.code,
      status: session.status,
      agent_os: session.agent_os,
      agent_arch: session.agent_arch,
      agent_host: session.agent_host,
      created_at: session.created_at,
      closed_at: session.closed_at,
    });
  }

  // POST /api/session/:code/cmd — run command via HTTP
  if (path.startsWith("/api/session/") && path.endsWith("/cmd") && method === "POST") {
    const code = path.split("/")[3];
    const session = getSession(code);
    if (!session) return notFound();
    if (session.status !== "active") {
      return json({ error: "Agent not connected" }, 400);
    }
    return req.json().then(async (body) => {
      const cmd = body.cmd || body.command;
      if (!cmd || typeof cmd !== "string") {
        return json({ error: "Missing cmd" }, 400);
      }
      audit(code, "http", "command", cmd);
      try {
        const result = await executeHttpCommand(code, cmd);
        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }).catch(() => json({ error: "Invalid JSON" }, 400));
  }

  // GET /api/sessions — list active
  if (path === "/api/sessions" && method === "GET") {
    return json(listActiveSessions());
  }

  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}
