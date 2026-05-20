import { hostname, userInfo } from "node:os";
import type { ProtocolMsg } from "../server/src/protocol.ts";

const WS_URL = process.env.BRIDGE_WS_URL || "wss://cya.wastu.net/ws";

function getInteractiveShell(): string[] {
  if (process.platform === "win32") return ["cmd.exe"];
  return [process.env.SHELL || "/bin/bash"];
}

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
  if (!/^\d{6}$/.test(code)) throw new Error("Usage: cya-bridge <6 digit session code>");

  const shell = getInteractiveShell();
  const ws = new WebSocket(WS_URL);
  const proc = Bun.spawn(shell, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: process.env,
  });

  console.log(`[CYA] Session ${code}`);
  console.log(`[CYA] Connect Your Agent is transparent. Commands from the connected assistant run on this machine.`);
  console.log(`[CYA] Press Ctrl+C to disconnect.`);

  pump(proc.stdout, ws);
  pump(proc.stderr, ws);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "join",
      session: code,
      role: "agent",
      meta: {
        os: process.platform,
        arch: process.arch,
        host: hostname(),
        user: safeUser(),
        cwd: process.cwd(),
        shell: shell.join(" "),
        elevated: isElevated(),
      },
    }));
  };

  ws.onmessage = async (event) => {
    const msg = parseMessage(String(event.data));
    if (!msg) return;

    if (msg.type === "command" && msg.id) {
      const result = await runOneShot(msg.cmd);
      ws.send(JSON.stringify({ type: "command_result", id: msg.id, ...result }));
      return;
    }

    if (msg.type === "command") {
      proc.stdin.write(`${msg.cmd}\n`);
      return;
    }

    if (msg.type === "bye") {
      shutdown(ws, proc, 0);
    }
  };

  ws.onclose = () => {
    console.log("\n[CYA] Connect Your Agent connection closed.");
    proc.kill(15);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    ws.send(JSON.stringify({ type: "bye", reason: "user_interrupt" }));
    shutdown(ws, proc, 0);
  });
}

async function pump(stream: ReadableStream<Uint8Array>, ws: WebSocket) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.send(JSON.stringify({ type: "output", data: new TextDecoder().decode(value) }));
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

function shutdown(ws: WebSocket, proc: Bun.Subprocess<"pipe", "pipe", "pipe">, code: number) {
  proc.kill(15);
  ws.close();
  process.exit(code);
}

main().catch((error) => {
  console.error("[CYA] Agent error:", error);
  process.exit(1);
});
