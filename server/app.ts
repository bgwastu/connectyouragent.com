import type { ServerWebSocket } from "bun";

function env(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var: ${key}`);
}

export const PORT = parseInt(env("PORT", "8765"), 10);
export const HOST = env("HOST", "0.0.0.0");
const SESSION_IDLE_TIMEOUT = parseInt(env("SESSION_IDLE_TIMEOUT", "300"), 10);
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const MIN_COMMAND_TIMEOUT_SECONDS = 1;
const MAX_COMMAND_TIMEOUT_SECONDS = 60 * 60;

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
} as const;

const indexHtml = await Bun.file(
  new URL("./static/index.html", import.meta.url),
).text();
const connectUnixSh = await Bun.file(
  new URL("./static/connect-unix.sh", import.meta.url),
).text();
const connectWindowsPs1 = await Bun.file(
  new URL("./static/connect-windows.ps1", import.meta.url),
).text();
const promptTemplate = await Bun.file(
  new URL("./static/prompt.md", import.meta.url),
).text();

export interface AgentMeta {
  host: string;
  os: string;
  arch: string;
  user: string;
  cwd?: string;
  shell?: string;
  elevated?: boolean;
}

interface CommandResult {
  output: string;
  exit_code: number;
  truncated: boolean;
}

type PendingCommand = {
  resolve: (value: CommandResult) => void;
  reject: (error: Error) => void;
  timer: Timer;
};

interface Session {
  code: string;
  meta?: AgentMeta;
  createdAt: number;
  lastActivity: number;
  agent: ServerWebSocket<unknown> | null;
  pendingHttp: Map<string, PendingCommand>;
}

type ProtocolMsg =
  | { type: "join"; session: string; role: "agent"; meta: AgentMeta }
  | {
      type: "command_result";
      id: string;
      output: string;
      exit_code: number;
      truncated?: boolean;
    }
  | { type: "error"; message: string }
  | { type: "bye"; reason?: string };

type RouteRequest = Request & { params: Record<string, string | undefined> };

const sessions = new Map<string, Session>();

export function isSessionCode(value: string): boolean {
  return /^[0-9a-f]{12}$/.test(value);
}

export function generateCode(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function createSession(code: string): Session {
  idleSweep();
  const now = Date.now();
  const session: Session = {
    code,
    createdAt: now,
    lastActivity: now,
    agent: null,
    pendingHttp: new Map(),
  };
  sessions.set(code, session);
  return session;
}

export function getSession(code: string): Session | undefined {
  idleSweep();
  return sessions.get(code);
}

export function closeSession(code: string): void {
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

export const routes = {
  "/": homeRoute,
  "/api/session": {
    POST: createSessionRoute,
  },
  "/api/session/:code": { GET: sessionInfoRoute },
  "/api/session/:code/disconnect": {
    GET: disconnectRoute,
    POST: disconnectRoute,
  },
  "/api/session/:code/run": {
    GET: commandRoute,
    POST: commandRoute,
  },
  "/api/session/:code/prompt.md": { GET: apiPromptRoute },
  "/c/:code": connectRoute,
  "/c/:code/windows.ps1": connectWindowsRoute,
  "/c/:code/prompt.md": promptRoute,
};

export function homeRoute(): Response {
  return html(indexHtml);
}

export function createSessionRoute(req: Request): Response {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const origin = effectiveOrigin(req);
  const code = createUniqueSessionCode();
  createSession(code);
  return json({
    code,
    status: "waiting",
    connect_url: `${origin}/c/${code}`,
  });
}

export function sessionInfoRoute(req: RouteRequest): Response {
  const code = routeCode(req);
  if (!code) return notFound();
  const session = getSession(code);
  if (!session) return notFound();
  return json(toSessionResponse(session, effectiveOrigin(req)));
}

export function disconnectRoute(req: RouteRequest): Response {
  const code = routeCode(req);
  if (!code) return notFound();
  if (!getSession(code)) return notFound();
  closeSession(code);
  return json({ ok: true, code, status: "closed" });
}

export function commandRoute(req: RouteRequest): Promise<Response> {
  const code = routeCode(req);
  if (!code) return Promise.resolve(notFound());
  const session = getSession(code);
  if (!session) return Promise.resolve(notFound());
  return handleCommand(req, new URL(req.url), session);
}

export function apiPromptRoute(req: RouteRequest): Response {
  return promptResponse(req);
}

export function connectRoute(req: RouteRequest): Response {
  const code = routeCode(req);
  if (!code) return notFound();
  const url = new URL(req.url);
  const acceptsHtml = req.headers.get("accept")?.includes("text/html") ?? false;
  if (acceptsHtml && url.searchParams.get("raw") !== "1") {
    if (!getSession(code)) return Response.redirect("/", 302);
    return html(indexHtml);
  }
  return connectUnixScript(code, effectiveOrigin(req));
}

export function connectWindowsRoute(req: RouteRequest): Response {
  const code = routeCode(req);
  if (!code) return notFound();
  return connectWindowsScript(code, effectiveOrigin(req));
}

export function promptRoute(req: RouteRequest): Response {
  return promptResponse(req);
}

function promptResponse(req: RouteRequest): Response {
  const code = routeCode(req);
  if (!code) return notFound();
  const session = getSession(code);
  if (!session) return notFound();
  const origin = effectiveOrigin(req);
  return markdown(buildPrompt(toSessionResponse(session, origin), origin));
}

function routeCode(req: RouteRequest): string | null {
  const code = req.params.code || "";
  return isSessionCode(code) ? code : null;
}

export function handleJoin(
  ws: ServerWebSocket<unknown>,
  msg: Extract<ProtocolMsg, { type: "join" }>,
): void {
  if (!isSessionCode(msg.session)) {
    rejectJoin(ws, "Invalid join request");
    return;
  }

  const session = sessions.get(msg.session);
  if (!session) {
    rejectJoin(ws, "Session not found or closed");
    return;
  }

  if (session.agent) {
    rejectJoin(ws, "Agent already connected");
    return;
  }

  session.meta = {
    host: msg.meta.host,
    os: msg.meta.os,
    arch: msg.meta.arch,
    user: msg.meta.user,
    cwd: msg.meta.cwd || "",
    shell: msg.meta.shell || "",
    elevated: msg.meta.elevated || false,
  };
  session.agent = ws;
  session.lastActivity = Date.now();
  ws.send(
    JSON.stringify({ type: "output", data: `Joined session ${msg.session}\n` }),
  );
}

export function handleAgentMessage(
  ws: ServerWebSocket<unknown>,
  raw: string,
): void {
  const msg = parseMessage(raw);
  if (!msg || msg.type !== "command_result") return;

  for (const session of sessions.values()) {
    if (session.agent !== ws) continue;
    const pending = session.pendingHttp.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pendingHttp.delete(msg.id);
    pending.resolve({
      output: msg.output,
      exit_code: msg.exit_code,
      truncated: msg.truncated === true,
    });
    return;
  }
}

export function handleDisconnect(ws: ServerWebSocket<unknown>): void {
  for (const session of sessions.values()) {
    if (session.agent !== ws) continue;
    session.agent = null;
    session.meta = undefined;
    session.lastActivity = Date.now();
    return;
  }
}

export async function requestHandler(
  req: Request,
  server: Bun.Server<unknown>,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    if (server.upgrade(req, { data: undefined })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  return (
    (await staticHandler(url.pathname)) ||
    new Response("Not found", { status: 404 })
  );
}

export function startServer() {
  return Bun.serve({
    hostname: HOST,
    port: PORT,
    routes,
    fetch: requestHandler,
    websocket: {
      open(_ws: ServerWebSocket<unknown>) {},
      message(ws: ServerWebSocket<unknown>, message) {
        const text =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        const msg = parseMessage(text);
        if (!msg) return;
        if (msg.type === "join") handleJoin(ws, msg);
        else handleAgentMessage(ws, text);
      },
      close(ws: ServerWebSocket<unknown>) {
        handleDisconnect(ws);
      },
    },
  });
}

async function handleCommand(
  req: Request,
  url: URL,
  session: Session,
): Promise<Response> {
  if (!session.agent) return json({ error: "Agent not connected" }, 409);

  let parsed: { cmd: string; timeout?: number } | null;
  try {
    parsed = await getCommand(req, url);
  } catch (error) {
    const status = error instanceof PayloadTooLargeError ? 413 : 400;
    return json(
      { error: error instanceof Error ? error.message : "Invalid command" },
      status,
    );
  }
  if (!parsed) {
    return json(
      {
        error:
          'Missing cmd. Use ?cmd=... for GET or JSON {"cmd":"..."} or {"cmd_b64":"..."}.',
      },
      400,
    );
  }
  if (session.pendingHttp.size > 0) {
    return json({ error: "Command already running" }, 409);
  }

  try {
    return json(await executeHttpCommand(session, parsed.cmd, parsed.timeout));
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Command failed" },
      500,
    );
  }
}

async function getCommand(
  req: Request,
  url: URL,
): Promise<{ cmd: string; timeout?: number } | null> {
  const queryCmd =
    url.searchParams.get("cmd") || url.searchParams.get("command");
  const queryB64 = url.searchParams.get("cmd_b64");
  if (queryB64) {
    const decoded = decodeBase64Command(queryB64);
    if (decoded) return { cmd: decoded };
  }
  if (queryCmd?.trim()) return { cmd: queryCmd };
  if (req.method !== "POST") return null;

  try {
    const body = await readJsonBody(req) as {
      cmd?: unknown;
      command?: unknown;
      cmd_b64?: unknown;
      timeout?: unknown;
    };
    let cmd = typeof body.cmd === "string" && body.cmd.trim() ? body.cmd : null;
    cmd ??=
      typeof body.command === "string" && body.command.trim()
        ? body.command
        : null;
    if (!cmd && typeof body.cmd_b64 === "string") {
      const decoded = decodeBase64Command(body.cmd_b64);
      if (decoded) cmd = decoded;
    }
    if (!cmd) return null;
    return {
      cmd,
      timeout: parseCommandTimeout(body.timeout),
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get("Content-Length") || "0");
  if (contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }

  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  return JSON.parse(raw);
}

function parseCommandTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_COMMAND_TIMEOUT_SECONDS ||
    value > MAX_COMMAND_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `Invalid timeout: expected ${MIN_COMMAND_TIMEOUT_SECONDS}-${MAX_COMMAND_TIMEOUT_SECONDS} seconds`,
    );
  }
  return value;
}

function decodeBase64Command(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new Error("Invalid cmd_b64: expected base64-encoded UTF-8");
  }

  const unpadded = raw.replace(/=+$/, "");
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error("Invalid cmd_b64: expected base64-encoded UTF-8");
  }

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .trim();
    return decoded || null;
  } catch {
    throw new Error("Invalid cmd_b64: expected base64-encoded UTF-8");
  }
}

function executeHttpCommand(
  session: Session,
  cmd: string,
  timeoutSec?: number,
): Promise<CommandResult> {
  if (!session.agent) return Promise.reject(new Error("Agent not connected"));

  const id = crypto.randomUUID();
  const timeoutMs = (timeoutSec ?? 30) * 1000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingHttp.delete(id);
      reject(
        new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    session.pendingHttp.set(id, { resolve, reject, timer });
    session.agent!.send(JSON.stringify({ type: "command", cmd, id }));
    session.lastActivity = Date.now();
  });
}

function createUniqueSessionCode(): string {
  const code = generateCode();
  if (sessions.has(code)) return createUniqueSessionCode();
  return code;
}

function sessionStatus(session: Session): "waiting" | "active" {
  return session.agent ? "active" : "waiting";
}

export function toSessionResponse(session: Session, baseUrl?: string) {
  const meta = session.meta;
  return {
    code: session.code,
    status: sessionStatus(session),
    meta: {
      host: meta?.host,
      os: meta?.os,
      arch: meta?.arch,
      user: meta?.user,
      cwd: meta?.cwd,
      shell: meta?.shell,
      elevated: meta?.elevated,
    },
    created_at: new Date(session.createdAt).toISOString(),
    connect_url: baseUrl
      ? `${baseUrl}/c/${session.code}`
      : `/c/${session.code}`,
    prompt_url: baseUrl
      ? `${baseUrl}/c/${session.code}/prompt.md`
      : `/c/${session.code}/prompt.md`,
    run_url: baseUrl
      ? `${baseUrl}/api/session/${session.code}/run?cmd=`
      : `/api/session/${session.code}/run?cmd=`,
  };
}

export function buildPrompt(
  session: ReturnType<typeof toSessionResponse>,
  baseUrl?: string,
): string {
  const meta = session.meta;
  return renderTemplate(promptTemplate, {
    code: session.code,
    status: session.status,
    host: meta.host || "unknown",
    remote: meta.user ? `${meta.user}@${meta.host}` : meta.host || "unknown",
    os_arch: meta.os && meta.arch ? `${meta.os}/${meta.arch}` : "unknown",
    cwd: meta.cwd || "unknown",
    shell: meta.shell || "unknown",
    elevated: meta.elevated ? "yes" : "no",
    connection_status:
      session.status === "active"
        ? "The agent is connected and ready."
        : "The bridge is not connected yet. Do not run commands or retry requests until the user connects the target machine.",
    run_url: baseUrl
      ? `${baseUrl}/api/session/${session.code}/run?cmd=`
      : `/api/session/${session.code}/run?cmd=`,
    base_url: baseUrl || "",
  });
}

function connectUnixScript(code: string, origin: string): Response {
  return text(renderTemplate(connectUnixSh, { origin, code }));
}

function connectWindowsScript(code: string, origin: string): Response {
  return text(
    renderTemplate(connectWindowsPs1, {
      origin,
      ws_origin: origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:"),
      code,
    }),
  );
}

async function staticHandler(path: string): Promise<Response | null> {
  if (!path.startsWith("/bin/")) return null;
  const fileName = path.slice(5);
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) return null;
  const file = Bun.file(`./public/bin/${fileName}`);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: { "Content-Type": "application/octet-stream", ...NO_CACHE },
  });
}

function parseMessage(raw: string): ProtocolMsg | null {
  try {
    const msg = JSON.parse(raw) as Partial<ProtocolMsg>;
    return typeof msg.type === "string" ? (msg as ProtocolMsg) : null;
  } catch {
    return null;
  }
}

function rejectJoin(ws: ServerWebSocket<unknown>, message: string): void {
  ws.send(JSON.stringify({ type: "error", message }));
  ws.close();
}

function idleSweep(): void {
  const closed = cleanup(SESSION_IDLE_TIMEOUT);
  if (closed.length) {
    console.log(
      `Cleaned up ${closed.length} stale sessions: ${closed.join(", ")}`,
    );
  }
}

function cleanup(idleSeconds: number): string[] {
  const now = Date.now();
  const closed = [];
  for (const session of sessions.values()) {
    const idle = (now - session.lastActivity) / 1000;
    if (!session.agent && idle > idleSeconds) {
      closeSession(session.code);
      closed.push(session.code);
    }
  }
  return closed;
}

function effectiveOrigin(req: Request): string {
  const proto =
    req.headers.get("X-Forwarded-Proto") === "https" ? "https" : "http";
  const host = req.headers.get("Host") || "localhost";
  return `${proto}://${host}`;
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /{{\s*([a-zA-Z0-9_]+)\s*}}/g,
    (_match, key) => values[key] ?? "",
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE },
  });
}

function markdown(data: string): Response {
  return new Response(data, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", ...NO_CACHE },
  });
}

function html(data: string): Response {
  return new Response(data, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function text(data: string): Response {
  return new Response(data, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

function methodNotAllowed(allowed: string[]): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Allow: allowed.join(", "),
      ...NO_CACHE,
    },
  });
}
