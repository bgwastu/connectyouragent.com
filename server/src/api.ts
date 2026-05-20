import { executeHttpCommand, isSessionCode } from "./relay.ts";
import * as store from "./store.ts";
import { effectiveOrigin, json, markdown, notFound } from "./http.ts";

type SessionResponse = ReturnType<typeof toSessionResponse>;
const promptTemplate = await Bun.file("./server/templates/prompt.md").text();

export function generateCode(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function apiHandler(req: Request, url: URL): Response | Promise<Response> | null {
  const path = url.pathname;
  const method = req.method;
  const origin = effectiveOrigin(req);

  if (path === "/api/session" && (method === "GET" || method === "POST")) {
    const code = createUniqueSessionCode();
    store.create(code);
    return json({
      code,
      status: "waiting",
      connect_url: origin ? `${origin}/c/${code}` : `/c/${code}`,
    });
  }

  if (path === "/api/sessions" && method === "GET") {
    return json(store.list());
  }

  const match = path.match(/^\/api\/session\/([0-9a-f]{12})(?:\/(run|cmd|disconnect|prompt(?:\.md)?))?$/);
  if (!match) return null;

  const code = match[1]!;
  const action = match[2] || "info";
  const session = store.get(code);
  if (!session) return notFound();

  if (action === "info" && method === "GET") {
    return json(toSessionResponse(session, origin));
  }

  if (action === "disconnect" && (method === "GET" || method === "POST")) {
    store.close(code);
    return json({ ok: true, code, status: "closed" });
  }

  if ((action === "prompt" || action === "prompt.md") && method === "GET") {
    return markdown(buildPrompt(toSessionResponse(session, origin), origin));
  }

  if ((action === "run" || action === "cmd") && (method === "GET" || method === "POST")) {
    return handleCommand(req, url, code, session.status);
  }

  return null;
}

async function handleCommand(req: Request, url: URL, code: string, status: string): Promise<Response> {
  if (!isSessionCode(code)) return json({ error: "Invalid session code" }, 400);
  if (status !== "active") return json({ error: "Agent not connected" }, 409);

  const parsed = await getCommand(req, url);
  if (!parsed) return json({ error: "Missing cmd. Use ?cmd=... for GET or JSON {\"cmd\":\"...\"} or {\"cmd_b64\":\"...\"}." }, 400);

  try {
    const result = await executeHttpCommand(code, parsed.cmd, parsed.timeout);
    return json(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Command failed" }, 500);
  }
}

async function getCommand(req: Request, url: URL): Promise<{ cmd: string; timeout?: number } | null> {
  const queryCmd = url.searchParams.get("cmd") || url.searchParams.get("command");
  const queryB64 = url.searchParams.get("cmd_b64");
  if (queryB64) {
    const decoded = Buffer.from(queryB64, "base64").toString("utf8").trim();
    if (decoded) return { cmd: decoded };
  }
  if (queryCmd?.trim()) return { cmd: queryCmd };

  if (req.method !== "POST") return null;

  try {
    const body = await req.json() as { cmd?: unknown; command?: unknown; cmd_b64?: unknown; timeout?: unknown };
    let cmd = typeof body.cmd === "string" && body.cmd.trim() ? body.cmd : null;
    cmd ??= typeof body.command === "string" && body.command.trim() ? body.command : null;
    if (!cmd && typeof body.cmd_b64 === "string") {
      const decoded = Buffer.from(body.cmd_b64, "base64").toString("utf8").trim();
      if (decoded) cmd = decoded;
    }
    if (!cmd) return null;
    const timeout = typeof body.timeout === "number" && body.timeout > 0 ? body.timeout : undefined;
    return { cmd, timeout };
  } catch {
    return null;
  }
}

function createUniqueSessionCode(): string {
  const code = generateCode();
  if (store.get(code)) return createUniqueSessionCode();
  return code;
}

export function toSessionResponse(session: store.Session, baseUrl?: string) {
  return {
    code: session.code,
    status: session.status,
    meta: {
      host: session.meta.host || undefined,
      os: session.meta.os || undefined,
      arch: session.meta.arch || undefined,
      user: session.meta.user || undefined,
      cwd: session.meta.cwd || undefined,
      shell: session.meta.shell || undefined,
      elevated: session.meta.elevated || undefined,
    },
    created_at: new Date(session.createdAt).toISOString(),
    connect_url: baseUrl ? `${baseUrl}/c/${session.code}` : `/c/${session.code}`,
    prompt_url: baseUrl ? `${baseUrl}/c/${session.code}/prompt.md` : `/c/${session.code}/prompt.md`,
    run_url: baseUrl ? `${baseUrl}/api/session/${session.code}/run?cmd=` : `/api/session/${session.code}/run?cmd=`,
  };
}

export function buildPrompt(session: SessionResponse, baseUrl?: string): string {
  const runUrl = baseUrl
    ? `${baseUrl}/api/session/${session.code}/run?cmd=`
    : `/api/session/${session.code}/run?cmd=`;
  const meta = session.meta;
  return renderTemplate(promptTemplate, {
    code: session.code,
    status: session.status,
    host: meta.host || "unknown",
    remote: meta.user ? `${meta.user}@${meta.host}` : meta.host || "unknown",
    os_arch: (meta.os && meta.arch) ? `${meta.os}/${meta.arch}` : "unknown",
    cwd: meta.cwd || "unknown",
    shell: meta.shell || "unknown",
    elevated: meta.elevated ? "yes" : "no",
    created_at: session.created_at,
    connection_status: session.status === "active"
      ? "The agent is connected and ready."
      : "The agent is not active yet. Wait until the user connects before running commands.",
    run_url: runUrl,
    base_url: baseUrl || "",
  });
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => values[key] ?? "");
}
