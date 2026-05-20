import type { ProtocolMsg } from "../server/src/protocol.ts";

const WS_URL = process.env.BRIDGE_WS_URL || "wss://cya.wastu.net/ws";

function getShell(): string[] {
  const platform = process.platform;
  if (platform === "win32") {
    return ["cmd.exe", "/c"];
  }
  return ["/bin/bash", "-c"];
}

function generateCode(): Promise<string> {
  return fetch(`${WS_URL.replace("wss:", "https:")}/api/session`, { method: "POST" })
    .then((r) => r.json())
    .then((j: any) => j.code);
}

async function main() {
  const code = await generateCode();
  console.log(`Bridge session code: ${code}`);
  console.log(`Share this code with your AI assistant.`);

  const ws = new WebSocket(`${WS_URL}?session=${code}&role=agent`);

  const shellCmd = getShell()[0];
  const shellArgs = getShell().slice(1);
  const proc = Bun.spawn([shellCmd, ...shellArgs, ""], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: process.env,
  });

  // Forward shell stdout/stderr to WebSocket
  const reader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();

  async function pumpOutput() {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        ws.send(JSON.stringify({ type: "output", data: text }));
      }
    } catch {}
  }

  async function pumpError() {
    try {
      while (true) {
        const { done, value } = await errReader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        ws.send(JSON.stringify({ type: "output", data: text }));
      }
    } catch {}
  }

  pumpOutput();
  pumpError();

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "join",
      session: code,
      role: "agent",
    }));
  };

  ws.onmessage = (event) => {
    let msg: ProtocolMsg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "command" && msg.cmd) {
      const writer = proc.stdin.getWriter();
      writer.write(new TextEncoder().encode(msg.cmd + "\n"));
      writer.releaseLock();
    }
    if (msg.type === "bye") {
      proc.kill(15);
      ws.close();
      process.exit(0);
    }
  };

  ws.onclose = () => {
    console.log("\nBridge connection closed.");
    proc.kill(15);
    process.exit(0);
  };

  // Ctrl+C handler
  process.on("SIGINT", () => {
    ws.send(JSON.stringify({ type: "bye", reason: "user_interrupt" }));
    ws.close();
    proc.kill(15);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Agent error:", e);
  process.exit(1);
});
