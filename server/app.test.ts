import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPrompt,
  closeSession,
  commandRoute,
  connectRoute,
  connectWindowsRoute,
  createSession,
  createSessionRoute,
  generateCode,
  handleJoin,
  handleAgentMessage,
  homeRoute,
  isSessionCode,
  promptRoute,
  routes,
  sessionInfoRoute,
  toSessionResponse,
} from "./app.ts";

const createdCodes: string[] = [];

afterEach(() => {
  for (const code of createdCodes.splice(0)) closeSession(code);
});

function track(code: string): string {
  createdCodes.push(code);
  return code;
}

function create(code: string): string {
  createSession(code);
  return track(code);
}

async function json(res: Response): Promise<unknown> {
  return await res.json();
}

function routeReq(
  url: string,
  params: Record<string, string>,
  init?: RequestInit,
): Request & { params: Record<string, string> } {
  return Object.assign(new Request(url, init), { params });
}

describe("session API", () => {
  test("isSessionCode accepts 12-char hex codes", () => {
    expect(isSessionCode("a1b2c3d4e5f6")).toBe(true);
    expect(isSessionCode("123456789012")).toBe(true);
    expect(isSessionCode("abcdefabcdef")).toBe(true);
    expect(isSessionCode("a1b2c3d4e5f")).toBe(false);
    expect(isSessionCode("a1b2c3d4e5f6g")).toBe(false);
    expect(isSessionCode("A1b2c3d4e5f6")).toBe(false);
  });

  test("generateCode returns valid 12-char lowercase hex codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(isSessionCode(generateCode())).toBe(true);
    }
  });

  test("does not expose session enumeration", () => {
    expect("/api/sessions" in routes).toBe(false);
  });

  test("creates sessions through POST only", async () => {
    expect((routes["/api/session"] as Record<string, unknown>).GET).toBeUndefined();

    const getRes = createSessionRoute(new Request("http://test.local/api/session", {
      method: "GET",
      headers: { Host: "test.local" },
    }));
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("Allow")).toBe("POST");

    const req = new Request("http://test.local/api/session", {
      method: "POST",
      headers: { Host: "test.local" },
    });
    const res = createSessionRoute(req);
    expect(res).toBeInstanceOf(Response);
    const body = await json(res) as {
      code: string;
      status: string;
      connect_url: string;
    };
    track(body.code);
    expect(isSessionCode(body.code)).toBe(true);
    expect(body.status).toBe("waiting");
    expect(body.connect_url).toBe(`http://test.local/c/${body.code}`);
  });

  test("returns 404 for unknown sessions", async () => {
    const req = routeReq("http://test.local/api/session/abcdefabcdef", {
      code: "abcdefabcdef",
    });
    const res = sessionInfoRoute(req);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "Not found" });
  });

  test("rejects command requests while the agent is disconnected", async () => {
    const code = create("111111111111");
    const req = routeReq(`http://test.local/api/session/${code}/run?cmd=pwd`, { code });
    const res = await commandRoute(req);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "Agent not connected" });
  });

  test("rejects invalid base64 commands before sending them to the bridge", async () => {
    const code = create("121212121212");
    const ws = wsStub();
    handleJoin(ws as never, {
      type: "join",
      session: code,
      role: "agent",
      meta: { host: "test", os: "linux", arch: "x64", user: "test" },
    });

    const req = routeReq(
      `http://test.local/api/session/${code}/run?cmd_b64=${encodeURIComponent("test 16")}`,
      { code },
    );
    const res = await commandRoute(req);

    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: "Invalid cmd_b64: expected base64-encoded UTF-8",
    });
    expect(ws.sent.join("\n")).not.toContain('"type":"command"');
  });

  test("rejects concurrent commands for the same session", async () => {
    const code = create("131313131313");
    const ws = wsStub();
    handleJoin(ws as never, {
      type: "join",
      session: code,
      role: "agent",
      meta: { host: "test", os: "linux", arch: "x64", user: "test" },
    });

    const first = commandRoute(
      routeReq(`http://test.local/api/session/${code}/run?cmd=sleep`, { code }),
    );
    await Bun.sleep(0);
    const sent = ws.sent
      .map((message) => JSON.parse(message) as { id?: string; type: string })
      .find((message) => message.type === "command");
    expect(sent?.id).toBeString();

    const second = await commandRoute(
      routeReq(`http://test.local/api/session/${code}/run?cmd=pwd`, { code }),
    );
    expect(second.status).toBe(409);
    expect(await json(second)).toEqual({ error: "Command already running" });

    handleAgentMessage(ws as never, JSON.stringify({
      type: "command_result",
      id: sent!.id,
      output: "ok",
      exit_code: 0,
      truncated: true,
    }));
    expect(await json(await first)).toEqual({ output: "ok", exit_code: 0, truncated: true });
  });

  test("rejects invalid command timeouts before sending them to the bridge", async () => {
    const code = create("141414141414");
    const ws = wsStub();
    handleJoin(ws as never, {
      type: "join",
      session: code,
      role: "agent",
      meta: { host: "test", os: "linux", arch: "x64", user: "test" },
    });

    for (const timeout of [-1, 0, 3601]) {
      const res = await commandRoute(routeReq(
        `http://test.local/api/session/${code}/run`,
        { code },
        {
          method: "POST",
          body: JSON.stringify({ cmd: "pwd", timeout }),
        },
      ));
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        error: "Invalid timeout: expected 1-3600 seconds",
      });
    }
    expect(ws.sent.join("\n")).not.toContain('"type":"command"');
  });

  test("rejects command POST bodies over 64KB before sending them to the bridge", async () => {
    const code = create("151515151515");
    const ws = wsStub();
    handleJoin(ws as never, {
      type: "join",
      session: code,
      role: "agent",
      meta: { host: "test", os: "linux", arch: "x64", user: "test" },
    });

    const res = await commandRoute(routeReq(
      `http://test.local/api/session/${code}/run`,
      { code },
      {
        method: "POST",
        body: JSON.stringify({ cmd: "x".repeat(64 * 1024) }),
      },
    ));

    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({
      error: "Request body must be 65536 bytes or smaller",
    });
    expect(ws.sent.join("\n")).not.toContain('"type":"command"');
  });

  test("renders prompt as non-interactive one-shot command guidance", () => {
    const session = createSession(track("222222222222"));
    const prompt = buildPrompt(
      toSessionResponse(session, "http://test.local"),
      "http://test.local",
    );

    expect(prompt).toContain("non-interactive shell command access");
    expect(prompt).toContain("cmd_b64");
    expect(prompt).toContain("http://test.local/api/session/222222222222/run?cmd=");
  });
});

describe("page and installer routes", () => {
  test("serves the home page", async () => {
    const res = homeRoute();
    expect(res?.headers.get("Content-Type")).toContain("text/html");
    expect(await res!.text()).toContain("Connect Your Agent");
  });

  test("serves Unix installer without Python or PTY dependencies", async () => {
    const code = create("333333333333");
    const req = routeReq(`http://test.local/c/${code}?raw=1`, { code }, {
      headers: { Host: "test.local" },
    });
    const res = connectRoute(req);
    const script = await res!.text();

    expect(script).toContain("#!/bin/sh");
    expect(script).toContain(`CODE="${code}"`);
    expect(script).toContain("cya-bridge-${OS}-${ARCH}");
    expect(script).toContain("elf_ei_data");
    expect(script).toContain("mips32el) ARCH=mipsel");
    expect(script).toContain("ARCH=mips64el ;;");
    expect(script).toContain("BRIDGE_WS_URL");
    expect(script).not.toContain("python3");
    expect(script.toLowerCase()).not.toContain("pty");
  });

  test("serves Windows PowerShell installer", async () => {
    const code = create("444444444444");
    const req = routeReq(`https://test.local/c/${code}/windows.ps1`, { code }, {
      headers: { Host: "test.local", "X-Forwarded-Proto": "https" },
    });
    const res = connectWindowsRoute(req);
    const script = await res!.text();

    expect(script).toContain('$ErrorActionPreference = "Stop"');
    expect(script).toContain(`$Code = "${code}"`);
    expect(script).toContain("cya-bridge-windows-x64.exe");
    expect(script).toContain("wss://test.local/ws");
    expect(script).toContain("Invoke-WebRequest");
  });

  test("returns prompt content for existing sessions", async () => {
    const code = create("555555555555");
    const req = routeReq(`http://test.local/c/${code}/prompt.md`, { code });
    const res = promptRoute(req);
    const prompt = await res!.text();

    expect(res?.headers.get("Content-Type")).toContain("text/markdown");
    expect(prompt).toContain("non-interactive shell command access");
  });
});

describe("websocket relay", () => {
  test("rejects a second agent for the same session code", () => {
    const code = create("a1b2c3d4e5f6");
    const first = wsStub();
    const second = wsStub();

    handleJoin(first as never, {
      type: "join",
      session: code,
      role: "agent",
      meta: { host: "test", os: "linux", arch: "x64", user: "test" },
    });
    handleJoin(second as never, {
      type: "join",
      session: code,
      role: "agent",
      meta: { host: "test2", os: "linux", arch: "x64", user: "test2" },
    });

    expect(first.closed).toBe(false);
    expect(second.closed).toBe(true);
    expect(second.sent.join("\n")).toContain("Agent already connected");
  });
});

function wsStub() {
  return {
    data: undefined as unknown,
    sent: [] as string[],
    closed: false,
    send(message: string) {
      this.sent.push(message);
    },
    close() {
      this.closed = true;
    },
  };
}

const port = String(19_000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;

let server: Bun.Subprocess | null = null;
let bridge: Bun.Subprocess | null = null;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeModuleDir = join(repoRoot, "bridge");

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "server/index.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOST: "127.0.0.1", PORT: port },
  });

  await waitFor(async () => {
    const res = await fetch(`${baseUrl}/`);
    return res.ok;
  }, "server startup");
});

afterAll(() => {
  bridge?.kill(9);
  server?.kill(9);
});

describe("full local server and bridge flow", () => {
  test("connects bridge and executes GET, POST, base64, timeout, and disconnect flows", async () => {
    const session = await postJson(`${baseUrl}/api/session`, {}) as { code: string };
    expect(session.code).toMatch(/^[0-9a-f]{12}$/);

    const bridgeCommand = await bridgeSpawnCommand(session.code);
    bridge = Bun.spawn(bridgeCommand.argv, {
      cwd: bridgeCommand.cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, BRIDGE_WS_URL: wsUrl },
    });

    await waitFor(async () => {
      const info = await getJson(`${baseUrl}/api/session/${session.code}`) as {
        status: string;
      };
      return info.status === "active";
    }, "bridge activation");

    const info = await getJson(`${baseUrl}/api/session/${session.code}`) as {
      meta: { os: string; arch: string; shell: string };
    };
    expect(info.meta.os).toBe(process.platform);
    expect(info.meta.arch).toBe(process.arch);
    expect(info.meta.shell).toBe(process.platform === "win32" ? "powershell.exe" : "/bin/sh");

    const marker = `CYA_E2E_${Date.now()}`;
    const getResult = await getJson(
      `${baseUrl}/api/session/${session.code}/run?cmd=${encodeURIComponent(echoCommand(marker))}`,
    ) as { exit_code: number; output: string; truncated: boolean };
    expect(getResult.exit_code).toBe(0);
    expect(getResult.output).toContain(marker);
    expect(getResult.truncated).toBe(false);

    const postResult = await postJson(`${baseUrl}/api/session/${session.code}/run`, {
      cmd: echoCommand("CYA_POST_OK"),
      timeout: 10,
    }) as { exit_code: number; output: string; truncated: boolean };
    expect(postResult.exit_code).toBe(0);
    expect(postResult.output).toContain("CYA_POST_OK");
    expect(postResult.truncated).toBe(false);

    const b64Result = await postJson(`${baseUrl}/api/session/${session.code}/run`, {
      cmd_b64: Buffer.from(echoCommand("CYA_B64_OK")).toString("base64"),
      timeout: 10,
    }) as { exit_code: number; output: string; truncated: boolean };
    expect(b64Result.exit_code).toBe(0);
    expect(b64Result.output).toContain("CYA_B64_OK");
    expect(b64Result.truncated).toBe(false);

    const timeoutResult = await postJson(`${baseUrl}/api/session/${session.code}/run`, {
      cmd: sleepCommand(3),
      timeout: 1,
    }) as { exit_code?: number; error?: string };
    expect(timeoutResult.exit_code === 0 || typeof timeoutResult.error === "string").toBe(true);
    if (typeof timeoutResult.error === "string") {
      expect(timeoutResult.error).toContain("timed out");
    }

    const disconnect = await postJson(
      `${baseUrl}/api/session/${session.code}/disconnect`,
      {},
    );
    expect(disconnect).toEqual({ ok: true, code: session.code, status: "closed" });
  }, 30_000);
});

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  return await res.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
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
  if (process.platform === "win32") {
    return `powershell -NoProfile -Command "Start-Sleep -Seconds ${seconds}"`;
  }
  return `sleep ${seconds}`;
}

async function bridgeSpawnCommand(code: string): Promise<{
  argv: string[];
  cwd: string;
}> {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const exe = os === "windows" ? ".exe" : "";
  const binary = join(repoRoot, "public", "bin", `cya-bridge-${os}-${process.arch}${exe}`);
  if (await Bun.file(binary).exists()) {
    return { argv: [binary, code], cwd: repoRoot };
  }
  return { argv: ["go", "run", ".", code], cwd: bridgeModuleDir };
}
