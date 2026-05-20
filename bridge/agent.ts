import { hostname, userInfo } from "node:os";
import type { ProtocolMsg } from "../server/src/protocol.ts";
import { parseMessage } from "../server/src/protocol.ts";

const WS_URL = requiredEnv("BRIDGE_WS_URL");
const MAX_BUFFERED_AMOUNT = 1024 * 1024;

// ANSI
const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", red: "\x1b[31m" } as const;
const DOT = `${C.cyan}●${C.reset}`;
const ARROW = `${C.cyan}▶${C.reset}`;
function print(...args: string[]) { process.stdout.write(args.join(" ") + "\n"); }

function safeUser(): string {
  try { return userInfo().username; } catch {}
  return process.env.USER || process.env.USERNAME || "unknown";
}

function isElevated(): boolean {
  try { return userInfo().uid === 0; } catch {}
  if (typeof process.getuid === "function") { try { return process.getuid() === 0; } catch {} }
  if (process.env.SUDO_UID) return true;
  if (process.platform === "win32") return process.env.USERNAME?.toLowerCase() === "administrator";
  return false;
}

function getInteractiveShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return "/bin/sh";
}

function getPtyCommand(shell: string): string[] {
  if ((process.platform === "darwin" || process.platform === "linux") && commandExists("python3")) {
    return ["python3", "-c", PYTHON_PTY_BRIDGE, shell];
  }
  return [shell];
}

function commandExists(command: string): boolean {
  try {
    const probe = Bun.spawnSync(["/bin/sh", "-lc", `command -v ${command}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
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

async function main() {
  const code = process.argv[2];
  if (!code || !/^[0-9a-f]{12}$/.test(code)) throw new Error("Usage: cya-bridge <session code>");

  const shell = getInteractiveShell();
  const ptyCommand = getPtyCommand(shell);
  const ws = new WebSocket(WS_URL);
  const ptyEnv: Record<string, string> = { ...process.env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" } as Record<string, string>;
  if (process.platform !== "win32") ptyEnv.SHELL = "/bin/sh";

  const term = Bun.spawn(ptyCommand, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: ptyEnv,
  });

  print(`${DOT} ${C.bold}${code}${C.reset}  —  Ctrl+C to disconnect`);

  pump(term.stdout, ws);
  pump(term.stderr, ws);
  term.exited.then((exitCode) => done(exitCode || 0));

  ws.onopen = () => {
    sendJson(ws, {
      type: "join",
      session: code,
      role: "agent",
      meta: {
        host: hostname(),
        os: process.platform,
        arch: process.arch,
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
      print(`${DOT} ${C.red}Server error:${C.reset} ${msg.message}`);
      return;
    }

    if (msg.type === "command" && msg.id) {
      print(`${ARROW} ${C.bold}${msg.cmd}${C.reset}`);
      const result = await runOneShot(msg.cmd);
      if (result.output) {
        const lines = result.output.split("\n");
        for (const line of lines) process.stdout.write(`${C.dim}  ${line}${C.reset}\n`);
      }
      sendJson(ws, { type: "command_result", id: msg.id, ...result });
      return;
    }

    if (msg.type === "bye") {
      ws.close(1000);
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    print(`\n${DOT} Connection closed.${C.reset}`);
    try { term.kill(9); } catch {}
    if (!exiting) process.exit(0);
  };

  let exiting = false;

  function done(code: number) {
    if (exiting) return;
    exiting = true;
    if (ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: "bye", reason: `exit:${code}` });
      ws.close(1000);
    }
    setTimeout(() => {
      try { term.kill(9); } catch {}
      process.exit(code);
    }, 1500);
  }

  process.on("SIGINT", () => done(0));
  process.on("SIGTERM", () => done(0));
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

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

main().catch((error) => {
  print(`${DOT} ${C.red}Error:${C.reset} ${error}`);
  process.exit(1);
});
