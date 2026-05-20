import { buildPrompt, toSessionResponse } from "./api.ts";
import { BASE_URL } from "./config.ts";
import { getSession } from "./db.ts";

/** Detect the effective origin (protocol + host) behind TLS-terminating proxies. */
function effectiveOrigin(req: Request): string {
  const proto =
    req.headers.get("X-Forwarded-Proto") === "https" ? "https" : "http";
  const host = req.headers.get("Host") || "localhost";
  return `${proto}://${host}`;
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Your Agent</title>
<style>
body { margin: 0; background: #fff; color: #111; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
[hidden] { display: none !important; }
main { max-width: 640px; margin: 36px auto; padding: 0 18px; }
.stack { display: grid; gap: 12px; }
.header { font-weight: 700; }
.muted { color: #666; }
.small { font-size: 12px; }
.line { border-top: 1px solid #eee; padding-top: 12px; }
ul { list-style-type: disc; padding-left: 20px; margin: 0px }
pre { margin: 0; padding: 12px; overflow-x: auto; white-space: pre-wrap; background: #fafafa; border: 1px solid #eee; border-radius: 4px; }
button { min-height: 32px; padding-left: 10px; padding-right: 10px; }
a { color: inherit; }
</style>
</head>
<body>
<main>
  <div id="home" class="stack">
    <div class="header">Connect Your Agent</div>
    <div class="muted">Temporary shell access for AI agent. Create a session, run one command on the target machine, then paste the prompt into Claude Code, Codex, OpenClaw, or another AI agent.</div>
    <div class="header line">Use Cases</div>
    <ul>
      <li>Ask AI to check why your server is running out of disk space at 3am.</li>
      <li>Ask AI to set up a new dev machine while you keep working.</li>
      <li>Give AI temporary access to a throwaway machine, lab box, or recovery environment.</li>
    </ul>
    <div class="muted">Supported OS: macOS Intel/Apple Silicon, Linux x64/arm64, Windows x64.</div>
    <button id="create-session">Create Session</button>
  </div>

  <div id="session" class="stack" hidden>
    <div class="small"><a href="/">Go to Home</a></div>

    <div id="waiting" class="stack line">
      <div>Run on the target machine:</div>
      <pre id="cmd"></pre>
      <button id="copy-cmd">Copy</button>
      <div><strong>Tip:</strong> Replace <code>bash</code> with <code>sudo bash</code> if you want AI agent to operate as elevated/root.</div>
      <div class="muted">Waiting for connection...</div>
      <div id="expiry" class="muted"></div>
    </div>

    <div id="active" class="stack line" hidden>
      <div>Connected</div>
      <div id="status" class="muted"></div>
      <button id="disconnect">Disconnect</button>
      <div class="line">Paste this into any AI coding agent to start controlling your computer:</div>
      <pre id="short-prompt"></pre>
      <button id="copy-prompt">Copy Prompt</button>
    </div>
  </div>
</main>

<script>
const BASE = location.origin;
const match = location.pathname.match(new RegExp("^/c/([a-z]+-[a-z]+-[a-z]+\\\\d{4})"));
const CODE = match ? match[1] : null;

function $(id) { return document.getElementById(id); }
function promptUrl(code) { return BASE + "/c/" + code + "/prompt.md"; }
function connectCommand(code) { return "curl -fsSL " + BASE + "/c/" + code + " | bash"; }
function expiresAt(session) { return new Date(session.created_at.replace(" ", "T") + "Z").getTime() + 5 * 60 * 1000; }

async function copyText(id, button, label) {
  await navigator.clipboard.writeText($(id).textContent);
  const old = button.textContent;
  button.textContent = label;
  button.disabled = true;
  setTimeout(function() { button.textContent = old; button.disabled = false; }, 1200);
}

function showWaiting(session) {
  $("waiting").hidden = false;
  $("active").hidden = true;
  $("cmd").textContent = connectCommand(session.code);
  updateExpiry(session);
}

function showActive(session) {
  $("waiting").hidden = true;
  $("active").hidden = false;
  $("status").textContent = [
    (session.agent_user || "unknown") + "@" + (session.agent_host || "unknown"),
    (session.agent_os || "unknown") + "/" + (session.agent_arch || "unknown"),
    "CWD " + (session.agent_cwd || "unknown"),
    "Elevated/root: " + (session.agent_elevated ? "yes" : "no")
  ].join(" · ");
  $("short-prompt").textContent = "Fetch this prompt: " + promptUrl(session.code);
}

function updateExpiry(session) {
  const seconds = Math.max(0, Math.ceil((expiresAt(session) - Date.now()) / 1000));
  if (seconds <= 0) {
    location.replace("/");
    return;
  }
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  $("expiry").textContent = "Expires in " + minutes + ":" + remainder;
}

async function poll() {
  const r = await fetch(BASE + "/api/session/" + CODE);
  if (!r.ok) { location.replace("/"); return; }
  const session = await r.json();
  if (session.status === "closed") { location.replace("/"); return; }
  if (session.status === "active") showActive(session);
  else showWaiting(session);
}

async function main() {
  if (!CODE) {
    $("create-session").onclick = async function() {
      const button = this;
      button.textContent = "Creating...";
      button.disabled = true;
      try {
        const r = await fetch(BASE + "/api/session");
        const j = await r.json();
        location.replace("/c/" + j.code);
      } catch {
        button.textContent = "Try Again";
        button.disabled = false;
      }
    };
    return;
  }

  $("home").hidden = true;
  $("session").hidden = false;
  $("copy-cmd").onclick = function() { copyText("cmd", this, "Copied"); };
  $("copy-prompt").onclick = function() { copyText("short-prompt", this, "Copied"); };
  $("disconnect").onclick = async function() {
    await fetch(BASE + "/api/session/" + CODE + "/disconnect");
    location.replace("/");
  };
  await poll();
  setInterval(poll, 1000);
}

main().catch(function() { $("home").innerHTML = "<div>Connect Your Agent</div><div class='muted'>failed to create session. refresh to retry.</div>"; });
</script>
</body>
</html>`;

export function pagesHandler(req: Request, url: URL): Response | null {
  const path = url.pathname;

  if (path === "/") {
    return html(HTML_TEMPLATE);
  }

  const connectMatch = path.match(/^\/c\/([a-z]+-[a-z]+-[a-z]+\d{4})$/);
  if (connectMatch) {
    const acceptsHtml =
      req.headers.get("accept")?.includes("text/html") ?? false;
    if (acceptsHtml && url.searchParams.get("raw") !== "1")
      return html(HTML_TEMPLATE);
    return connectScript(connectMatch[1]!, effectiveOrigin(req));
  }

  const promptMatch = path.match(
    /^\/c\/([a-z]+-[a-z]+-[a-z]+\d{4})\/prompt(?:\.md)?$/,
  );
  if (promptMatch) {
    const session = getSession(promptMatch[1]!);
    if (!session) return Response.json({ error: "Not found" }, { status: 404 });
    const origin = effectiveOrigin(req);
    return markdown(buildPrompt(toSessionResponse(session, origin), origin));
  }

  if (path === "/tools") {
    return Response.json({
      tools: [
        {
          name: "cya_shell",
          description:
            "Execute a shell command on the connected CYA remote machine. GET-compatible.",
          endpoint: `${url.origin}/api/session/{code}/run?cmd={url_encoded_command}`,
          method: "GET",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      ],
    });
  }

  return null;
}

export function connectScript(
  code: string,
  requestOrigin = BASE_URL,
): Response {
  const script = `#!/bin/bash
set -euo pipefail
BASE_URL="${requestOrigin}"
CODE="${code}"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then ARCH="arm64"; fi
BIN_NAME="cya-bridge-\${OS}-\${ARCH}"
if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
  echo "[CYA] Unsupported OS: \${OS}. Use Linux or macOS for curl-based connect."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[CYA] python3 is required for PTY mode. Attempting install..."
  if [ "$OS" = "darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install python
    elif command -v xcode-select >/dev/null 2>&1; then
      echo "[CYA] Homebrew not found. Installing Xcode command line tools prompt may appear."
      xcode-select --install || true
    else
      echo "[CYA] Please install Python 3, then rerun this command."
      exit 1
    fi
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y python3
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y python3
    elif command -v yum >/dev/null 2>&1; then
      sudo yum install -y python3
    elif command -v apk >/dev/null 2>&1; then
      sudo apk add --no-cache python3
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -Sy --noconfirm python
    elif command -v zypper >/dev/null 2>&1; then
      sudo zypper install -y python3
    else
      echo "[CYA] No supported package manager found. Please install Python 3, then rerun this command."
      exit 1
    fi
  fi
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[CYA] python3 is still unavailable. Please install Python 3, then rerun this command."
  exit 1
fi
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
echo "[CYA] Downloading agent for \${OS}-\${ARCH}..."
curl -fsSL "\${BASE_URL}/bin/\${BIN_NAME}" -o "\${TMPDIR}/\${BIN_NAME}"
chmod +x "\${TMPDIR}/\${BIN_NAME}"
BRIDGE_WS_URL="\${BASE_URL/http/ws}/ws" "\${TMPDIR}/\${BIN_NAME}" "\${CODE}"
`;
  return new Response(script, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function markdown(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
