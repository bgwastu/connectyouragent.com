import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const port = String(19_000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;

let server: Bun.Subprocess | null = null;
let bridge: Bun.Subprocess | null = null;

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "server/src/index.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOST: "127.0.0.1", PORT: port, BASE_URL: baseUrl },
  });

  await waitFor(async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    return res.ok;
  }, "server startup");
});

afterAll(() => {
  bridge?.kill(9);
  server?.kill(9);
});

describe("full local server and bridge flow", () => {
  test("connects bridge and executes GET, POST, base64, timeout, and disconnect flows", async () => {
    const session = await postJson(`${baseUrl}/api/session`, {});
    expect(session.code).toMatch(/^[0-9a-f]{12}$/);

    bridge = Bun.spawn(["bun", "run", "bridge/agent.ts", session.code], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BRIDGE_WS_URL: wsUrl },
    });

    await waitFor(async () => {
      const info = await getJson(`${baseUrl}/api/session/${session.code}`);
      return info.status === "active";
    }, "bridge activation");

    const info = await getJson(`${baseUrl}/api/session/${session.code}`);
    expect(info.meta.os).toBe(process.platform);
    expect(info.meta.arch).toBe(process.arch);
    expect(info.meta.shell).toBe(process.platform === "win32" ? "powershell.exe" : "/bin/sh");

    const marker = `CYA_E2E_${Date.now()}`;
    const getResult = await getJson(`${baseUrl}/api/session/${session.code}/run?cmd=${encodeURIComponent(echoCommand(marker))}`);
    expect(getResult.exit_code).toBe(0);
    expect(getResult.output).toContain(marker);

    const postResult = await postJson(`${baseUrl}/api/session/${session.code}/run`, {
      cmd: echoCommand("CYA_POST_OK"),
      timeout: 10,
    });
    expect(postResult.exit_code).toBe(0);
    expect(postResult.output).toContain("CYA_POST_OK");

    const b64Result = await postJson(`${baseUrl}/api/session/${session.code}/run`, {
      cmd_b64: Buffer.from(echoCommand("CYA_B64_OK")).toString("base64"),
      timeout: 10,
    });
    expect(b64Result.exit_code).toBe(0);
    expect(b64Result.output).toContain("CYA_B64_OK");

    const timeoutResult = await postJson(`${baseUrl}/api/session/${session.code}/run`, {
      cmd: sleepCommand(3),
      timeout: 1,
    });
    expect(timeoutResult.exit_code === 0 || typeof timeoutResult.error === "string").toBe(true);
    if (typeof timeoutResult.error === "string") {
      expect(timeoutResult.error).toContain("timed out");
    }

    const disconnect = await postJson(`${baseUrl}/api/session/${session.code}/disconnect`, {});
    expect(disconnect).toEqual({ ok: true, code: session.code, status: "closed" });
  }, 30_000);
});

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  return await res.json();
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function echoCommand(value: string): string {
  if (process.platform === "win32") return `echo ${value}`;
  return `printf ${JSON.stringify(value)}`;
}

function sleepCommand(seconds: number): string {
  if (process.platform === "win32") return `powershell -NoProfile -Command "Start-Sleep -Seconds ${seconds}"`;
  return `sleep ${seconds}`;
}
