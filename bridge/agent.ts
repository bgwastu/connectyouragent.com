import { hostname, userInfo } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolMsg } from "../server/src/protocol.ts";

const WS_URL = requiredEnv("BRIDGE_WS_URL");
const MAX_BUFFERED_AMOUNT = 1024 * 1024;

// Session command log
function getHomeDir(): string {
  try { return userInfo().homedir; } catch {}
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}
const LOG_DIR = join(getHomeDir(), ".cya", "logs");
let logPath = "";

function initLog(code: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  logPath = join(LOG_DIR, `${code}.log`);
}

function log(entry: string) {
  if (!logPath) return;
  try {
    const ts = new Date().toISOString();
    appendFileSync(logPath, `[${ts}] ${entry}\n`);
  } catch {}
}

function getInteractiveShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return "/bin/sh";
}

function getPtyCommand(shell: string): string[] {
  if (process.platform === "darwin" || process.platform === "linux") {
    return ["python3", "-c", PYTHON_PTY_BRIDGE, shell];
  }
  return [shell];
}

const PYTHON_PTY_BRIDGE = String.raw`
import os, pty, select, signal, subprocess, sys, termios, tty

shell = sys.argv[1]
master, slave = pty.openpty()
env = os.environ.copy()
env.setdefault("TERM", "xterm-256color")
proc = subprocess.Popen([shell], stdin=slave, stdout=slave, stderr=slave, cwd=os.getcwd(), env=env, close_fds=True)
os.close(slave)

try:
    while True:
        readable, _, _ = select.select([sys.stdin.buffer, master], [], [])
        if master in readable:
            try:
                data = os.read(master, 4096)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in readable:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            os.write(master, data)
finally:
    try:
        proc.terminate()
    except Exception:
        pass
    sys.exit(proc.wait() if proc.poll() is not None else 0)
`;

function getOneShotShell(cmd: string): string[] {
  if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", cmd];
  return [process.env.SHELL || "/bin/bash", "-lc", cmd];
}

async function createSession(): Promise<string> {
  const apiUrl = WS_URL.replace("wss:", "https:").replace("ws:", "http:").replace(/\/ws$/, "/api/session");
  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error(`Unable to create session: ${response.status}`);
  const body = await response.json() as { code?: string };
  if (!body.code) throw new Error("Session API did not return a code");
  return body.code;
}

async function main() {
  const code = process.argv[2] || await createSession();
  if (!/^[0-9a-f]{12}$/.test(code)) throw new Error("Usage: cya-bridge <session code>");

  const shell = getInteractiveShell();
  const ptyCommand = getPtyCommand(shell);
  const ws = new WebSocket(WS_URL);
  const ptyEnv: Record<string, string> = { ...process.env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" } as Record<string, string>;
  if (process.platform !== "win32") {
    ptyEnv.SHELL = "/bin/sh";
  }
  const term = Bun.spawn(ptyCommand, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: ptyEnv,
  });

  console.log(`[CYA] Session ${code} — press Ctrl+C to disconnect.`);
  initLog(code);
  log(`session_start user=${safeUser()} cwd=${process.cwd()} shell=${shell} elevated=${isElevated()}`);

  pump(term.stdout, ws);
  pump(term.stderr, ws);
  term.exited.then((exitCode) => done(exitCode || 0));

  ws.onopen = () => {
    sendJson(ws, {
      type: "join",
      session: code,
      role: "agent",
      meta: {
        os: process.platform,
        arch: process.arch,
        host: hostname(),
        user: safeUser(),
        cwd: process.cwd(),
        shell,
        elevated: isElevated(),
      },
    });
  };

  ws.onmessage = async (event) => {
    const msg = parseMessage(String(event.data));
    if (!msg) return;

    if (msg.type === "error") {
      console.error(`[CYA] Server error: ${msg.message}`);
      return;
    }

    if (msg.type === "output" && msg.data.startsWith("[CYA]")) {
      // Server status messages — already printed our own session info above
      return;
    }

    if (msg.type === "input") {
      term.stdin.write(decodePayload(msg.data, msg.encoding));
      return;
    }

    if (msg.type === "resize") {
      sendOutput(ws, `\r\n[CYA] Resize requested: ${clamp(msg.cols, 20, 300)}x${clamp(msg.rows, 5, 100)}\r\n`);
      return;
    }

    if (msg.type === "signal") {
      writeSignal(term, msg.name);
      return;
    }

    if (msg.type === "command" && msg.id) {
      log(`cmd http: ${msg.cmd}`);
      sendOutput(ws, `[CYA] # ${msg.cmd}\n`);
      const result = await runOneShot(msg.cmd);
      log(`cmd_result id=${msg.id} exit=${result.exit_code} out=${result.output.slice(0, 200)}`);
      sendJson(ws, { type: "command_result", id: msg.id, ...result });
      return;
    }

    if (msg.type === "command") {
      log(`cmd tty: ${msg.cmd}`);
      sendOutput(ws, `[CYA] # ${msg.cmd}\n`);
      term.stdin.write(`${msg.cmd}\r`);
      return;
    }

    if (msg.type === "bye") {
      ws.close(1000);
      return;
    }
  };

  ws.onerror = (event) => {
    console.error("[CYA] WebSocket error:", event);
  };

  let exiting = false;

  function done(code: number) {
    if (exiting) return;
    exiting = true;
    if (ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: "bye", reason: `exit:${code}` });
      ws.close(1000);
    }
    // Give ws.onclose time to fire before force-exit
    setTimeout(() => {
      try { term.kill(9); } catch {}
      process.exit(code);
    }, 1500);
  }

  ws.onclose = () => {
    console.log(`\n[CYA] Connection closed.`);
    try { term.kill(9); } catch {}
    if (!exiting) process.exit(0);
  };

  process.on("SIGINT", () => done(0));
}

async function pump(stream: ReadableStream<Uint8Array>, ws: WebSocket) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sendOutput(ws, new TextDecoder().decode(value));
    }
  } catch {}
}

async function runOneShot(cmd: string): Promise<{ output: string; exit_code: number }> {
  const child = Bun.spawn(getOneShotShell(cmd), {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output: stdout + stderr, exit_code: exitCode };
}

function sendOutput(ws: WebSocket, data: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_AMOUNT) return;
  sendJson(ws, { type: "output", data: Buffer.from(data, "utf8").toString("base64"), encoding: "base64" });
}

function sendJson(ws: WebSocket, value: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function decodePayload(data: string, encoding?: "utf8" | "base64") {
  if (encoding === "base64") return Buffer.from(data, "base64").toString("utf8");
  return data;
}

function writeSignal(term: Bun.Subprocess<"pipe", "pipe", "pipe">, signal: string) {
  if (signal === "SIGINT") term.stdin.write("\x03");
  else if (signal === "SIGQUIT") term.stdin.write("\x1c");
  else if (signal === "SIGHUP") term.stdin.write("\x04");
  else term.kill(signal as Parameters<typeof term.kill>[0]);
}

function parseMessage(raw: string): ProtocolMsg | null {
  try {
    return JSON.parse(raw) as ProtocolMsg;
  } catch {
    return null;
  }
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

function isElevated(): boolean {
  // userInfo() from node:os works in both Bun dev and compiled mode
  try {
    return userInfo().uid === 0;
  } catch {}

  // Fallback for Bun dev mode
  if (typeof process.getuid === "function") {
    try {
      return process.getuid() === 0;
    } catch {}
  }

  // SUDO_UID is set when process was launched via sudo
  if (process.env.SUDO_UID) {
    return true;
  }

  if (process.platform === "win32") {
    return process.env.USERNAME?.toLowerCase() === "administrator" || process.env.CYA_ELEVATED === "1";
  }

  return false;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

main().catch((error) => {
  console.error("[CYA] Agent error:", error);
  process.exit(1);
});

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}
