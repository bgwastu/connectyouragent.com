import { BASE_URL } from "./config.ts";

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bridge — Connect Your Agent</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222;background:#fafafa}
code{background:#eee;padding:2px 6px;border-radius:4px}
pre{background:#111;color:#0f0;padding:16px;border-radius:8px;overflow-x:auto}
a{color:#06c}
h1{font-size:1.5rem}
</style></head>
<body>
<h1>Bridge — Connect Your Agent</h1>
<p>Temporary shell bridge between a remote machine and any AI assistant.</p>

<h2>Run on the target machine</h2>
<pre><code>curl -s ${BASE_URL} | bash</code></pre>

<p>A 6-digit code will appear. Share it with your AI.</p>

<h2>For AI assistants</h2>
<ul>
<li><a href="/prompt">/prompt</a> — copy-paste instructions for any AI</li>
<li><a href="/tools">/tools</a> — JSON tool schemas (OpenAI / MCP compatible)</li>
</ul>

<p style="color:#666;font-size:0.85rem;margin-top:40px">
The connection persists until you press Ctrl+C on the remote terminal.
</p>
</body></html>`;

const PROMPT_TEXT = `You have been given access to a remote machine via Bridge.

To connect: open a WebSocket to ${BASE_URL.replace("https://", "wss://")}/ws?session=CODE&role=client
Or use HTTP: POST ${BASE_URL}/api/session/CODE/cmd with JSON body {"cmd": "ls -la"}

Replace CODE with the 6-digit code provided by the user.

Capabilities:
- Run shell commands persistently (cwd, env vars, background jobs survive across commands)
- Stream output in real-time via WebSocket
- Use HTTP API for one-shot commands with JSON responses

Safety:
- The remote user sees everything you run
- They can terminate the session at any time with Ctrl+C
- Sessions expire after 2 hours of inactivity
`;

const TOOLS_SCHEMA = {
  name: "bridge_shell",
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
};

export function pagesHandler(req: Request, url: URL): Response | null {
  const path = url.pathname;

  if (path === "/") {
    return new Response(LANDING_HTML, { headers: { "Content-Type": "text/html" } });
  }

  if (path === "/prompt") {
    return new Response(PROMPT_TEXT, { headers: { "Content-Type": "text/plain" } });
  }

  if (path === "/tools") {
    return new Response(JSON.stringify({ tools: [TOOLS_SCHEMA] }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}
