import { audit, createSession, getSession, listActiveSessions } from "./db.ts";
import { executeHttpCommand, getOrCreateSlot, isSessionCode, removeSlot } from "./relay.ts";

type SessionResponse = ReturnType<typeof toSessionResponse>;
const promptTemplate = await Bun.file("./server/templates/raw.md").text();

export function generateCode(): string {
  const adjectives = ["sage", "quiet", "brisk", "bright", "calm", "clever", "gentle", "honest", "lucky", "solar"];
  const nouns = ["daffodil", "henna", "cedar", "ember", "fig", "harbor", "ivy", "jasmine", "meadow", "willow"];
  const tails = ["antirust", "gab", "orbit", "signal", "anchor", "cobalt", "delta", "pixel", "raven", "topaz"];
  const pick = (items: string[]) => items[crypto.getRandomValues(new Uint32Array(1))[0]! % items.length]!;
  const digit = crypto.getRandomValues(new Uint32Array(1))[0]! % 10;
  return `${pick(adjectives)}-${pick(nouns)}-${pick(tails)}${digit}`;
}

export function apiHandler(req: Request, url: URL): Response | Promise<Response> | null {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/session" && (method === "GET" || method === "POST")) {
    const code = createUniqueSessionCode();
    createSession(code);
    getOrCreateSlot(code);
    audit(code, "system", "session_created");
    return json({ code, status: "waiting", connect_url: `/c/${code}` });
  }

  if (path === "/api/sessions" && method === "GET") {
    return json(listActiveSessions());
  }

  const match = path.match(/^\/api\/session\/([a-z]+-[a-z]+-[a-z]+\d)(?:\/(run|cmd|disconnect|prompt(?:\.md)?))?$/);
  if (!match) return null;

  const code = match[1]!;
  const action = match[2] || "info";
  const session = getSession(code);
  if (!session) return notFound();

  if (action === "info" && method === "GET") {
    return json(toSessionResponse(session));
  }

  if (action === "disconnect" && (method === "GET" || method === "POST")) {
    removeSlot(code, "user_disconnect");
    return json({ ok: true, code, status: "closed" });
  }

  if ((action === "prompt" || action === "prompt.md") && method === "GET") {
    return markdown(buildPrompt(toSessionResponse(session)));
  }

  if ((action === "run" || action === "cmd") && (method === "GET" || method === "POST")) {
    return handleCommand(req, url, code, session.status);
  }

  return null;
}

async function handleCommand(req: Request, url: URL, code: string, status: string): Promise<Response> {
  if (!isSessionCode(code)) return json({ error: "Invalid session code" }, 400);
  if (status !== "active") return json({ error: "Agent not connected" }, 409);

  const cmd = await getCommand(req, url);
  if (!cmd) return json({ error: "Missing cmd. Use ?cmd=... for GET or JSON {\"cmd\":\"...\"}." }, 400);

  audit(code, "http", "command", cmd);
  try {
    const result = await executeHttpCommand(code, cmd);
    return json(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Command failed" }, 500);
  }
}

async function getCommand(req: Request, url: URL): Promise<string | null> {
  const queryCmd = url.searchParams.get("cmd") || url.searchParams.get("command");
  if (queryCmd?.trim()) return queryCmd;
  if (req.method !== "POST") return null;

  try {
    const body = await req.json() as { cmd?: unknown; command?: unknown };
    const cmd = body.cmd || body.command;
    return typeof cmd === "string" && cmd.trim() ? cmd : null;
  } catch {
    return null;
  }
}

function createUniqueSessionCode(): string {
  for (let attempts = 0; attempts < 20; attempts++) {
    const code = generateCode();
    if (!getSession(code)) return code;
  }
  throw new Error("Unable to allocate session code");
}

export function toSessionResponse(session: NonNullable<ReturnType<typeof getSession>>) {
  return {
    code: session.code,
    status: session.status,
    agent_os: session.agent_os,
    agent_arch: session.agent_arch,
    agent_host: session.agent_host,
    agent_user: session.agent_user,
    agent_cwd: session.agent_cwd,
    agent_shell: session.agent_shell,
    agent_elevated: Boolean(session.agent_elevated),
    created_at: session.created_at,
    updated_at: session.updated_at,
    closed_at: session.closed_at,
    connect_url: `/c/${session.code}`,
    prompt_url: `/c/${session.code}/prompt.md`,
    capabilities: ["shell"],
  };
}

export function buildPrompt(session: SessionResponse): string {
  const hasStatus = session.status === "active";
  const runUrl = `/api/session/${session.code}/run?cmd=`;
  return renderTemplate(promptTemplate, {
    code: session.code,
    status: session.status,
    remote: `${session.agent_user || "unknown"}@${session.agent_host || "unknown"}`,
    os_arch: `${session.agent_os || "unknown"}/${session.agent_arch || "unknown"}`,
    cwd: session.agent_cwd || "unknown",
    shell: session.agent_shell || "unknown",
    elevated: session.agent_elevated ? "yes" : "no",
    created_at: session.created_at,
    updated_at: session.updated_at,
    connection_status: hasStatus
      ? "The agent is connected and ready."
      : "The agent is not active yet. Wait until the user connects the machine before running commands.",
    run_url: runUrl,
  });
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => values[key] ?? "");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function markdown(data: string): Response {
  return new Response(data, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}
