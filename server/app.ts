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
const HEARTBEAT_INTERVAL_SEC = parseInt(env("HEARTBEAT_INTERVAL", "25"), 10);
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
const notFoundTemplate = await Bun.file(
  new URL("./static/not-found.md", import.meta.url),
).text();
const cyaCryptoJs = await Bun.file(
  new URL("./static/cya-crypto.js", import.meta.url),
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

export interface EncryptedMeta {
  enc: true;
  iv: string;
  data: string;
}

interface CommandResult {
  output?: string;
  exit_code?: number;
  truncated?: boolean;
  enc?: boolean;
  id?: string;
  iv?: string;
  data?: string;
}

export interface CommandHistoryEntry {
  id: string;
  cmd?: string;
  timestamp: number;
  exit_code?: number;
  output?: string;
  truncated?: boolean;
  enc?: boolean;
  cmd_iv?: string;
  cmd_data?: string;
  resp_iv?: string;
  resp_data?: string;
}

type PendingCommand = {
  cmd: string;
  timestamp: number;
  enc?: boolean;
  cmd_iv?: string;
  cmd_data?: string;
  resolve: (value: CommandResult) => void;
  reject: (error: Error) => void;
  timer: Timer;
};

type PendingFileRead = {
  resolve: (value: { path: string; data: string; size: number; enc?: boolean; iv?: string }) => void;
  reject: (error: Error) => void;
  timer: Timer;
};

interface Session {
  code: string;
  meta?: AgentMeta;
  encMeta?: EncryptedMeta;
  createdAt: number;
  lastActivity: number;
  agent: ServerWebSocket<unknown> | null;
  pendingHttp: Map<string, PendingCommand>;
  pendingFileRead: Map<string, PendingFileRead>;
  history: CommandHistoryEntry[];
}

type ProtocolMsg =
  | {
      type: "join";
      session: string;
      role: "agent";
      meta?: AgentMeta;
      enc?: boolean;
      iv?: string;
      data?: string;
    }
  | {
      type: "command_result";
      id: string;
      output?: string;
      exit_code?: number;
      truncated?: boolean;
      enc?: boolean;
      iv?: string;
      data?: string;
    }
  | { type: "error"; message: string }
  | { type: "bye"; reason?: string }
  | { type: "ping" }
  | { type: "pong" }
  | {
      type: "file_read_result";
      id: string;
      path?: string;
      data: string;
      size?: number;
      error?: string;
      enc?: boolean;
      iv?: string;
    };

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
    pendingFileRead: new Map(),
    history: [],
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
  for (const pending of session.pendingFileRead.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Session closed"));
  }
  session.pendingFileRead.clear();
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
  "/api/session/:code/download": {
    GET: downloadRoute,
  },
  "/api/session/:code/prompt.md": { GET: apiPromptRoute },
  "/cya-crypto.js": {
    GET: () =>
      new Response(cyaCryptoJs, {
        headers: { "Content-Type": "application/javascript; charset=utf-8", ...NO_CACHE },
      }),
  },
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
  let code = createUniqueSessionCode();
  try {
    const url = new URL(req.url);
    const requested = url.searchParams.get("code") || req.headers.get("X-Session-Code");
    if (requested && isSessionCode(requested) && !sessions.has(requested)) {
      code = requested;
    }
  } catch {}
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
  const code = req.params.code || "";
  const origin = effectiveOrigin(req);
  if (!isSessionCode(code)) {
    return Promise.resolve(expiredCommandResponse(code, origin));
  }
  const session = getSession(code);
  if (!session) {
    return Promise.resolve(expiredCommandResponse(code, origin));
  }
  return handleCommand(req, new URL(req.url), session);
}

function expiredCommandResponse(code: string, origin: string): Response {
  return json(
    {
      error: "Session unavailable",
      session: code || "unknown",
      about:
        "CYA gives an AI agent temporary, user-approved command access to a machine without opening inbound ports or sharing SSH credentials. Sessions are 100% in-memory and ephemeral.",
      message: `The requested CYA session (${code || "unknown"}) is no longer available. It has either expired due to idle timeout, been closed by the user, or the session code is invalid. Please ask the user to start a new session at ${origin}.`,
    },
    404,
  );
}

export async function downloadRoute(req: RouteRequest): Promise<Response> {
  const code = routeCode(req);
  if (!code) return notFound();
  const session = getSession(code);
  if (!session) return notFound();
  if (!session.agent) return json({ error: "Agent not connected" }, 409);

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const encPathIv = url.searchParams.get("iv");
  const encPathData = url.searchParams.get("data");

  if (!path && !(encPathIv && encPathData)) {
    return json({ error: "Missing ?path= or ?iv=&data= query parameter" }, 400);
  }

  try {
    const encPayload = encPathIv && encPathData ? { iv: encPathIv, data: encPathData } : undefined;
    const result = await executeFileRead(session, path || "", 30, encPayload);
    if (result.enc) {
      return json({
        enc: true,
        iv: result.iv,
        data: result.data,
      });
    }
    const bytes = Buffer.from(result.data, "base64");
    const filename = (path || "download").split("/").filter(Boolean).pop() || "download";
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": String(result.size),
        ...NO_CACHE,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Download failed";
    return json({ error: msg }, 500);
  }
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
  const code = req.params.code || "";
  const origin = effectiveOrigin(req);
  if (!isSessionCode(code)) {
    return expiredPromptResponse(code, origin);
  }
  const session = getSession(code);
  if (!session) {
    return expiredPromptResponse(code, origin);
  }
  return markdown(buildPrompt(toSessionResponse(session, origin), origin));
}

function expiredPromptResponse(code: string, origin: string): Response {
  const body = renderTemplate(notFoundTemplate, {
    code: code || "unknown",
    origin: origin || "the CYA host",
  });

  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...NO_CACHE,
    },
  });
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

  if (msg.enc && msg.iv && msg.data) {
    session.encMeta = {
      enc: true,
      iv: msg.iv,
      data: msg.data,
    };
    session.meta = undefined;
  } else if (msg.meta) {
    session.meta = {
      host: msg.meta.host,
      os: msg.meta.os,
      arch: msg.meta.arch,
      user: msg.meta.user,
      cwd: msg.meta.cwd || "",
      shell: msg.meta.shell || "",
      elevated: msg.meta.elevated || false,
    };
    session.encMeta = undefined;
  }

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
  if (!msg) return;

  for (const session of sessions.values()) {
    if (session.agent !== ws) continue;

    if (msg.type === "command_result") {
      const pending = session.pendingHttp.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pendingHttp.delete(msg.id);

      if (msg.enc && msg.iv && msg.data) {
        const res: CommandResult = {
          enc: true,
          id: msg.id,
          iv: msg.iv,
          data: msg.data,
        };
        session.history.push({
          id: msg.id,
          enc: true,
          cmd_iv: pending.cmd_iv,
          cmd_data: pending.cmd_data,
          resp_iv: msg.iv,
          resp_data: msg.data,
          timestamp: pending.timestamp,
        });
        if (session.history.length > 50) {
          session.history.shift();
        }
        pending.resolve(res);
        return;
      }

      const res: CommandResult = {
        output: msg.output ?? "",
        exit_code: msg.exit_code ?? 0,
        truncated: msg.truncated === true,
      };
      session.history.push({
        id: msg.id,
        cmd: pending.cmd,
        timestamp: pending.timestamp,
        exit_code: res.exit_code ?? 0,
        output: res.output ?? "",
        truncated: res.truncated ?? false,
      });
      if (session.history.length > 50) {
        session.history.shift();
      }
      pending.resolve(res);
      return;
    }

    if (msg.type === "file_read_result" && msg.id) {
      const pending = session.pendingFileRead.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pendingFileRead.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve({
          path: msg.path || "",
          data: msg.data,
          size: msg.size || 0,
          enc: msg.enc,
          iv: msg.iv,
        });
      }
      return;
    }
  }
}

export function handleDisconnect(ws: ServerWebSocket<unknown>): void {
  for (const session of sessions.values()) {
    if (session.agent !== ws) continue;
    session.agent = null;
    session.meta = undefined;
    session.encMeta = undefined;
    session.lastActivity = Date.now();
    for (const pending of session.pendingFileRead.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent disconnected"));
    }
    session.pendingFileRead.clear();
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
    (await staticHandler(url.pathname, req)) ||
    new Response("Not found", { status: 404 })
  );
}

export function startServer() {
  // Periodic cleanup every 30s
  setInterval(() => idleSweep(), 30_000);

  const server = Bun.serve({
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
        else if (msg.type === "pong") {
          // Bridge is alive — update lastActivity
          for (const session of sessions.values()) {
            if (session.agent === ws) {
              session.lastActivity = Date.now();
              return;
            }
          }
        } else handleAgentMessage(ws, text);
      },
      close(ws: ServerWebSocket<unknown>) {
        handleDisconnect(ws);
      },
    },
  });

  // Send WebSocket ping frames to all connected agents every HEARTBEAT_INTERVAL_SEC
  setInterval(() => {
    for (const session of sessions.values()) {
      if (session.agent) {
        try {
          session.agent.ping();
        } catch {
          // Connection likely dead; cleanup will handle it
        }
      }
    }
  }, HEARTBEAT_INTERVAL_SEC * 1000);

  return server;
}

type ParsedCommand =
  | { enc: false; cmd: string; timeout?: number }
  | { enc: true; id: string; iv: string; data: string; timeout?: number };

async function handleCommand(
  req: Request,
  url: URL,
  session: Session,
): Promise<Response> {
  if (!session.agent) return json({ error: "Agent not connected" }, 409);

  let parsed: ParsedCommand | null;
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
          'Missing cmd. Use ?cmd=... for GET or JSON {"cmd":"..."} or {"cmd_b64":"..."} or {"enc":true,...}.',
      },
      400,
    );
  }
  if (session.pendingHttp.size > 0) {
    return json({ error: "Command already running" }, 409);
  }

  if (parsed.enc) {
    try {
      return json(await executeEncryptedHttpCommand(session, parsed.id, parsed.iv, parsed.data, parsed.timeout));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Command failed" },
        500,
      );
    }
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
): Promise<ParsedCommand | null> {
  const queryCmd =
    url.searchParams.get("cmd") || url.searchParams.get("command");
  const queryB64 = url.searchParams.get("cmd_b64");
  if (queryB64) {
    const decoded = decodeBase64Command(queryB64);
    if (decoded) return { enc: false, cmd: decoded };
  }
  if (queryCmd?.trim()) return { enc: false, cmd: queryCmd };
  if (req.method !== "POST") return null;

  try {
    const body = await readJsonBody(req) as {
      cmd?: unknown;
      command?: unknown;
      cmd_b64?: unknown;
      timeout?: unknown;
      enc?: unknown;
      id?: unknown;
      iv?: unknown;
      data?: unknown;
    };
    if (body.enc === true && typeof body.iv === "string" && typeof body.data === "string") {
      const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : crypto.randomUUID();
      return {
        enc: true,
        id,
        iv: body.iv,
        data: body.data,
        timeout: parseCommandTimeout(body.timeout),
      };
    }
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
      enc: false,
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
  const raw = value.trim().replace(/\s/g, "");
  if (!raw) return null;

  // Convert base64url → standard base64
  const standard = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padding = standard.length % 4;
  const padded = padding === 0 ? standard : standard + "=".repeat(4 - padding);

  try {
    const bytes = Buffer.from(padded, "base64");
    // Try UTF-8 first (fatal on invalid sequences)
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      return decoded || null;
    } catch {
      // Fallback to a single-byte encoding to preserve all byte values
      const decoded = new (TextDecoder as any)("iso-8859-1").decode(bytes).trim();
      return decoded || null;
    }
  } catch {
    throw new Error("Invalid cmd_b64: expected base64-encoded data");
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

    session.pendingHttp.set(id, {
      cmd,
      timestamp: Date.now(),
      resolve,
      reject,
      timer,
    });
    session.agent!.send(JSON.stringify({ type: "command", cmd, id }));
    session.lastActivity = Date.now();
  });
}

function executeEncryptedHttpCommand(
  session: Session,
  id: string,
  iv: string,
  data: string,
  timeoutSec?: number,
): Promise<CommandResult> {
  if (!session.agent) return Promise.reject(new Error("Agent not connected"));

  const timeoutMs = (timeoutSec ?? 30) * 1000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingHttp.delete(id);
      reject(
        new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    session.pendingHttp.set(id, {
      cmd: "",
      enc: true,
      cmd_iv: iv,
      cmd_data: data,
      timestamp: Date.now(),
      resolve,
      reject,
      timer,
    });
    session.agent!.send(JSON.stringify({ type: "command", enc: true, id, iv, data }));
    session.lastActivity = Date.now();
  });
}

function executeFileRead(
  session: Session,
  path: string,
  timeoutSec = 30,
  encPayload?: { iv: string; data: string },
): Promise<{ path: string; data: string; size: number; enc?: boolean; iv?: string }> {
  if (!session.agent) return Promise.reject(new Error("Agent not connected"));

  const id = crypto.randomUUID();
  const timeoutMs = timeoutSec * 1000;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingFileRead.delete(id);
      reject(new Error(`File read timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    session.pendingFileRead.set(id, { resolve, reject, timer });
    if (encPayload) {
      session.agent!.send(JSON.stringify({ type: "file_read", id, enc: true, iv: encPayload.iv, data: encPayload.data }));
    } else {
      session.agent!.send(JSON.stringify({ type: "file_read", id, path }));
    }
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
    encrypted: !!session.encMeta,
    meta: {
      host: meta?.host,
      os: meta?.os,
      arch: meta?.arch,
      user: meta?.user,
      cwd: meta?.cwd,
      shell: meta?.shell,
      elevated: meta?.elevated,
    },
    enc_meta: session.encMeta,
    history: session.history,
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

async function staticHandler(path: string, req?: Request): Promise<Response | null> {
  if (path === "/bin/cya" && req) {
    const ua = req.headers.get("User-Agent")?.toLowerCase() || "";
    const isDarwin = ua.includes("darwin") || ua.includes("mac");
    const isWindows = ua.includes("win");
    const isArm64 = ua.includes("aarch64") || ua.includes("arm64");
    let target = isArm64 ? "linux-arm64" : "linux-x64";
    if (isDarwin) target = isArm64 ? "darwin-arm64" : "darwin-x64";
    else if (isWindows) target = "windows-x64.exe";
    const file = Bun.file(`./public/bin/cya-bridge-${target}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": "application/octet-stream", ...NO_CACHE },
      });
    }
  }

  if (path.startsWith("/bin/")) {
    const fileName = path.slice(5);
    if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) return null;
    const file = Bun.file(`./public/bin/${fileName}`);
    if (!(await file.exists())) return null;
    return new Response(file, {
      headers: { "Content-Type": "application/octet-stream", ...NO_CACHE },
    });
  }

  const rootFile = path.slice(1);
  if (/^[a-zA-Z0-9_.-]+$/.test(rootFile)) {
    const file = Bun.file(`./public/${rootFile}`);
    if (await file.exists()) {
      let contentType = "application/octet-stream";
      if (rootFile.endsWith(".svg")) contentType = "image/svg+xml";
      else if (rootFile.endsWith(".png")) contentType = "image/png";
      else if (rootFile.endsWith(".ico")) contentType = "image/x-icon";
      else if (rootFile.endsWith(".webmanifest")) contentType = "application/manifest+json";
      else if (rootFile.endsWith(".json")) contentType = "application/json";

      return new Response(file, {
        headers: { "Content-Type": contentType, ...NO_CACHE },
      });
    }
  }

  return null;
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

export function effectiveOrigin(req: Request): string {
  const forwardedProto = req.headers.get("X-Forwarded-Proto");
  const proto = forwardedProto
    ? forwardedProto.split(",")[0].trim()
    : req.url.startsWith("https://")
      ? "https"
      : "http";
  const forwardedHost = req.headers.get("X-Forwarded-Host");
  let host = forwardedHost
    ? forwardedHost.split(",")[0].trim()
    : req.headers.get("Host") || new URL(req.url).host || "localhost";
  if (host.startsWith("0.0.0.0")) {
    host = host.replace(/^0\.0\.0\.0/, "localhost");
  }
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
