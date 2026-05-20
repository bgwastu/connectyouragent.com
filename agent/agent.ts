import { hostname, userInfo } from "node:os";
import type { ProtocolMsg } from "../server/src/protocol.ts";

const WS_URL = requiredEnv("BRIDGE_WS_URL");
const MAX_BUFFERED_AMOUNT = 1024 * 1024;

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
  if (!/^[a-z]+-[a-z]+-[a-z]+\d$/.test(code)) throw new Error("Usage: cya-bridge <session passphrase>");

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

  console.log(`[CYA] Session ${code}`);
  console.log(`[CYA] Press Ctrl+C to disconnect.`);

  pump(term.stdout, ws);
  pump(term.stderr, ws);
  term.exited.then((exitCode) => {
    sendJson(ws, { type: "bye", reason: `pty_exit:${exitCode}` });
    ws.close();
    process.exit(exitCode || 0);
  });

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
      console.log(msg.data.trimEnd());
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
      const result = await runOneShot(msg.cmd);
      sendJson(ws, { type: "command_result", id: msg.id, ...result });
      return;
    }

    if (msg.type === "command") {
      term.stdin.write(`${msg.cmd}\r`);
      return;
    }

    if (msg.type === "bye") shutdown(ws, term, 0);
  };

  ws.onerror = (event) => {
    console.error("[CYA] WebSocket error:", event);
  };

  ws.onclose = (event) => {
    const detail = event.code || event.reason
      ? ` code=${event.code} reason=${event.reason || "none"}`
      : "";
    console.log(`\n[CYA] Connect Your Agent connection closed.${detail}`);
    term.kill(15);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    sendJson(ws, { type: "bye", reason: "user_interrupt" });
    shutdown(ws, term, 0);
  });
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
  if (typeof process.getuid === "function") return process.getuid() === 0;
  if (process.platform !== "win32") return false;
  return process.env.USERNAME?.toLowerCase() === "administrator" || process.env.CYA_ELEVATED === "1";
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function shutdown(ws: WebSocket, term: Bun.Subprocess<"pipe", "pipe", "pipe">, code: number) {
  term.kill(15);
  ws.close();
  process.exit(code);
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
