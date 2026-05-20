import { BASE_URL, WS_URL } from "./config.ts";

const CUA_DRIVER_DOCS = "https://github.com/trycua/cua/tree/main/libs/cua-driver";
const AGENT_BROWSER_DOCS = "https://github.com/vercel-labs/agent-browser";

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>CYA \u2014 Connect Your Bridge</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
button { padding: 5px 12px; cursor: pointer; font-size: 13px; margin-left: 4px; }
pre { background: #f5f5f5; padding: 12px; overflow-x: auto; font-size: 13px; }
ul { padding-left: 20px; }
li { margin: 8px 0; }
</style>
</head>
<body>

<div id="home">
<p>Generating session...</p>
</div>

<div id="session" hidden>
<div id="waiting">
<p>Waiting for connection...</p>
<p>Run this command on the target machine:</p>
<pre id="cmd"></pre>
</div>

<div id="active" hidden>
<p><strong>Connected.</strong></p>
<p id="close-hint"></p>
<button id="disconnect">Disconnect</button>

<h3>Capabilities:</h3>
<ul>
<li>Shell access</li>
<li id="desktop-li" hidden>
  Full desktop automation
  <span id="desktop-controls"></span>
</li>
<li id="browser-li">
  Browser automation
  <span id="browser-controls"></span>
</li>
</ul>

<p>Give this prompt to your AI assistant:</p>
<pre id="prompt"></pre>
</div>
</div>

<script>
const BASE = "${BASE_URL}";
const WS = "${WS_URL}";
const CUA_DRIVER_DOCS = "${CUA_DRIVER_DOCS}";
const AGENT_BROWSER_DOCS = "${AGENT_BROWSER_DOCS}";
const path = location.pathname;
const CODE = path === "/" ? null : path.slice(1);

function $(id) { return document.getElementById(id); }

function detectBrowserOS() {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Linux")) return "linux";
  return "unix";
}

function showCommand(code, os) {
  let cmd = "";
  if (os === "windows") {
    cmd = 'powershell -Command "$code=' + code + '; \\\n  $tmp=$env:TEMP; \\\n  irm ' + BASE + '/bin/bridge-agent-windows-x64.exe -OutFile \\"$tmp\\\\cya.exe\\"; \\\n  & \\"$tmp\\\\cya.exe\\" $code"';
  } else {
    cmd = "curl -fsSL " + BASE + "/connect/" + code + " | bash";
  }
  $("cmd").textContent = cmd;
}

function renderFeatureControls(containerId, feature, session) {
  const container = $(containerId);
  const enabled = session.features[feature];
  container.innerHTML = "";

  if (!enabled) {
    const btn = document.createElement("button");
    btn.textContent = "Install & Connect";
    btn.onclick = function() {
      btn.disabled = true;
      btn.textContent = "Installing...";
      fetch(BASE + "/api/session/" + CODE + "/features", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({[feature]: true})
      }).then(function() {
        poll();
      }).catch(function() {
        btn.disabled = false;
        btn.textContent = "Install & Connect";
      });
    };
    container.appendChild(btn);
  } else {
    const disableBtn = document.createElement("button");
    disableBtn.textContent = "Disable";
    disableBtn.onclick = function() {
      disableBtn.disabled = true;
      fetch(BASE + "/api/session/" + CODE + "/features", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({[feature]: false})
      }).then(function() {
        poll();
      }).catch(function() {
        disableBtn.disabled = false;
      });
    };
    container.appendChild(disableBtn);

    const uninstallBtn = document.createElement("button");
    uninstallBtn.textContent = "Disable & Uninstall";
    uninstallBtn.onclick = function() {
      uninstallBtn.disabled = true;
      fetch(BASE + "/api/session/" + CODE + "/features", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({[feature]: false})
      }).then(function() {
        poll();
      }).catch(function() {
        uninstallBtn.disabled = false;
      });
    };
    container.appendChild(uninstallBtn);
  }
}

function showActive(session) {
  $("waiting").hidden = true;
  $("active").hidden = false;

  const hint = session.agent_os === "win32"
    ? "Close the terminal window to disconnect"
    : "Press Ctrl+C in the terminal to disconnect";
  $("close-hint").textContent = hint;

  // Desktop automation (macOS only)
  if (session.agent_os === "darwin") {
    $("desktop-li").hidden = false;
    renderFeatureControls("desktop-controls", "desktop", session);
  } else {
    $("desktop-li").hidden = true;
  }

  // Browser automation (all platforms)
  renderFeatureControls("browser-controls", "browser", session);

  $("prompt").textContent = buildPrompt(session);
}

function buildPrompt(session) {
  let p = 'You have been given access to a remote machine via CYA (Connect Your Bridge).\\n\\n';
  p += 'Session code: ' + session.code + '\\n\\n';

  p += 'Connection:\\n';
  p += 'You are connected to the remote machine via WebSocket at ' + WS + '.\\n';
  p += 'The bridge running on the remote machine maintains a persistent shell session.\\n';
  p += 'All commands you send are executed on that machine and output is streamed back in real-time.\\n\\n';

  p += 'API:\\n\\n';

  p += '1. Shell commands (HTTP one-shot):\\n';
  p += '   POST ' + BASE + '/api/session/' + session.code + '/cmd\\n';
  p += '   Content-Type: application/json\\n';
  p += '   Body: {"cmd": "ls -la"}\\n';
  p += '   Response: {"output": "...", "exit_code": 0}\\n\\n';

  p += '2. Shell commands (WebSocket streaming):\\n';
  p += '   Send: {"type": "command", "cmd": "ls -la"}\\n';
  p += '   Receive: {"type": "output", "data": "..."}\\n\\n';

  p += '3. Feature control:\\n';
  p += '   Enable/disable features via HTTP:\\n';
  p += '   POST ' + BASE + '/api/session/' + session.code + '/features\\n';
  p += '   Body: {"desktop": true} or {"browser": true}\\n';
  p += '   Or via WebSocket: {"type": "enable_feature", "feature": "desktop", "enabled": true}\\n\\n';

  p += '4. WebSocket message reference:\\n';
  p += '   {"type": "join", "session": "' + session.code + '", "role": "client"}\\n';
  p += '   {"type": "command", "cmd": "ls -la"}\\n';
  p += '   {"type": "output", "data": "..."}\\n';
  p += '   {"type": "enable_feature", "feature": "desktop", "enabled": true}\\n';
  p += '   {"type": "feature_status", "features": {"shell": true, "desktop": true, ...}}\\n';
  p += '   {"type": "computer_use", "id": "1", "action": "capture", "mode": "som"}\\n';
  p += '   {"type": "computer_use_result", "id": "1", "result": {...}}\\n';
  p += '   {"type": "browser_use", "id": "1", "cmd": "open https://example.com"}\\n';
  p += '   {"type": "browser_use_result", "id": "1", "output": "..."}\\n';
  p += '   {"type": "bye", "reason": "..."}\\n';
  p += '   {"type": "error", "message": "..."}\\n\\n';

  p += '5. Session info:\\n';
  p += '   GET ' + BASE + '/api/session/' + session.code + '\\n';
  p += '   GET ' + BASE + '/api/session/' + session.code + '/features\\n\\n';

  p += 'Capabilities:\\n\\n';

  p += 'Shell:\\n';
  p += '- Run shell commands persistently (cwd, env, background jobs survive)\\n';
  p += '- Stream output in real-time via WebSocket\\n';
  p += '- Use HTTP API for one-shot commands with JSON responses\\n\\n';

  if (session.features.desktop) {
    p += 'Desktop (macOS):\\n';
    p += '- computer_use(action="capture", mode="som") \\u2014 screenshot with Set-of-Marks overlay\\n';
    p += '- computer_use(action="capture", mode="raw") \\u2014 raw screenshot without overlay\\n';
    p += '- computer_use(action="click", element=14) \\u2014 click element by index from SOM\\n';
    p += '- computer_use(action="click", x=100, y=200) \\u2014 click at absolute coordinates\\n';
    p += '- computer_use(action="type", text="hello world") \\u2014 type text at current focus\\n';
    p += '- computer_use(action="key", keys="return") \\u2014 press key(s), comma-separated for chords\\n';
    p += '- computer_use(action="scroll", direction="down") \\u2014 scroll up/down/left/right\\n';
    p += '- computer_use(action="drag", x=100, y=200, endX=300, endY=400) \\u2014 drag from start to end\\n\\n';
    p += 'API details: ' + CUA_DRIVER_DOCS + '\\n\\n';
  }

  if (session.features.browser) {
    p += 'Browser (agent-browser):\\n';
    p += '- browser_use(cmd="open https://example.com") \\u2014 open URL in browser\\n';
    p += '- browser_use(cmd="snapshot") \\u2014 get accessibility tree with @eN element refs\\n';
    p += '- browser_use(cmd="click \\"Submit\\"") \\u2014 click element by text/aria-label\\n';
    p += '- browser_use(cmd="click @e14") \\u2014 click element by ref from snapshot\\n';
    p += '- browser_use(cmd="type \\"Email\\" \\"user@example.com\\"") \\u2014 type into labeled field\\n';
    p += '- browser_use(cmd="screenshot") \\u2014 capture full-page screenshot\\n';
    p += '- browser_use(cmd="back") / browser_use(cmd="forward") \\u2014 navigate history\\n';
    p += '- browser_use(cmd="refresh") \\u2014 reload current page\\n\\n';
    p += 'API details: ' + AGENT_BROWSER_DOCS + '\\n\\n';
  }

  p += 'Note:\\n';
  p += '- The remote user sees everything you run\\n';
  p += '- They can terminate the session at any time\\n';
  p += '- Sessions expire after 2 hours of inactivity\\n';
  return p;
}

async function poll() {
  try {
    const r = await fetch(BASE + "/api/session/" + CODE);
    if (!r.ok) { location.replace("/"); return; }
    const s = await r.json();
    if (s.status === "closed") { location.replace("/"); return; }
    if (s.status === "waiting") {
      $("waiting").hidden = false;
      $("active").hidden = true;
      const os = detectBrowserOS();
      showCommand(s.code, os);
    } else {
      showActive(s);
    }
  } catch {
    location.replace("/");
  }
}

async function disconnect() {
  try {
    await fetch(BASE + "/api/session/" + CODE + "/disconnect", { method: "POST" });
  } catch {}
  location.replace("/");
}

async function main() {
  if (!CODE) {
    try {
      const r = await fetch(BASE + "/api/session", { method: "POST" });
      const j = await r.json();
      location.replace("/" + j.code);
    } catch {
      $("home").innerHTML = "<p>Error. Refresh to try again.</p>";
    }
    return;
  }

  $("home").hidden = true;
  $("session").hidden = false;

  await poll();
  setInterval(poll, 2000);

  $("disconnect").onclick = disconnect;
}

main().catch(function() {
  if (!CODE) $("home").innerHTML = "<p>Error. Refresh to try again.</p>";
  else location.replace("/");
});
</script>

</body>
</html>`;

export function pagesHandler(req: Request, url: URL): Response | null {
  const path = url.pathname;

  if (path === "/" || /^\/[0-9]{6}$/.test(path)) {
    return new Response(HTML_TEMPLATE, { headers: { "Content-Type": "text/html" } });
  }

  if (path === "/tools") {
    const schemas = [
      {
        name: "cya_shell",
        description: "Execute a shell command on the connected remote machine",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "Shell command to execute" },
          },
          required: ["cmd"],
        },
        endpoint: `${BASE_URL}/api/session/{code}/cmd`,
        method: "POST",
      },
      {
        name: "computer_use",
        description: "Control the remote macOS desktop (screenshot, click, type, etc.)",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["capture", "click", "type", "key", "scroll", "drag"], description: "Action to perform" },
            mode: { type: "string", description: "Capture mode: som or raw" },
            element: { type: "integer", description: "Element index to click" },
            x: { type: "integer", description: "X coordinate" },
            y: { type: "integer", description: "Y coordinate" },
            text: { type: "string", description: "Text to type" },
            keys: { type: "string", description: "Keys to press" },
            direction: { type: "string", description: "Scroll direction" },
            endX: { type: "integer", description: "End X coordinate for drag" },
            endY: { type: "integer", description: "End Y coordinate for drag" },
          },
          required: ["action"],
        },
      },
      {
        name: "browser_use",
        description: "Control the remote browser via agent-browser",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "agent-browser command (e.g. \"open https://example.com\", \"snapshot\", \"screenshot\", \"click Submit\", \"click @e14\")" },
          },
          required: ["cmd"],
        },
      },
    ];
    return new Response(JSON.stringify({ tools: schemas }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}
