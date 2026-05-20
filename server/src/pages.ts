import { buildPrompt, toSessionResponse } from "./api.ts";
import * as store from "./store.ts";
import { effectiveOrigin, html } from "./http.ts";

const indexHtml = await Bun.file(
  new URL("../templates/index.html", import.meta.url),
).text();

export function pagesHandler(req: Request, url: URL): Response | null {
  const path = url.pathname;

  if (path === "/") {
    return html(indexHtml);
  }

  const connectMatch = path.match(/^\/c\/([0-9a-f]{12})$/);
  if (connectMatch) {
    const code = connectMatch[1]!;
    const acceptsHtml =
      req.headers.get("accept")?.includes("text/html") ?? false;
    if (acceptsHtml && url.searchParams.get("raw") !== "1") {
      if (!store.get(code)) return Response.redirect("/", 302);
      return html(indexHtml);
    }
    return connectScript(code, effectiveOrigin(req));
  }

  const windowsConnectMatch = path.match(/^\/c\/([0-9a-f]{12})\/windows(?:\.ps1)?$/);
  if (windowsConnectMatch) {
    return windowsConnectScript(windowsConnectMatch[1]!, effectiveOrigin(req));
  }

  const promptMatch = path.match(/^\/c\/([0-9a-f]{12})\/prompt(?:\.md)?$/);
  if (promptMatch) {
    const session = store.get(promptMatch[1]!);
    if (!session) return Response.json({ error: "Not found" }, { status: 404 });
    const origin = effectiveOrigin(req);
    return new Response(
      buildPrompt(toSessionResponse(session, origin), origin),
      {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      },
    );
  }

  if (path === "/tools") {
    return Response.json({
      tools: [
        {
          name: "cya_shell",
          description:
            "Execute a shell command on the connected CYA remote machine. Supports GET and POST.",
          endpoint: `${url.origin}/api/session/{code}/run`,
          method: "POST",
          parameters: {
            type: "object",
            properties: {
              cmd: { type: "string", description: "Shell command to execute" },
              cmd_b64: {
                type: "string",
                description:
                  "Base64-encoded shell command (safer for special chars)",
              },
              timeout: {
                type: "number",
                description: "Timeout in seconds (1-300, default 30)",
              },
            },
            required: [],
          },
        },
      ],
    });
  }

  return null;
}

function windowsConnectScript(code: string, requestOrigin: string): Response {
  const wsOrigin = requestOrigin.replace(/^http/, "ws");
  const script = `$ErrorActionPreference = "Stop"
$BaseUrl = "${requestOrigin}"
$BridgeWsUrl = "${wsOrigin}/ws"
$Code = "${code}"
$BridgeName = "cya-bridge-windows-x64.exe"
$InstallDir = Join-Path $env:TEMP "cya"
$BridgePath = Join-Path $InstallDir $BridgeName

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "Downloading CYA bridge for Windows x64..."
Invoke-WebRequest -Uri "$BaseUrl/bin/$BridgeName" -OutFile $BridgePath

$env:BRIDGE_WS_URL = $BridgeWsUrl
Write-Host "Starting CYA bridge session $Code..."
& $BridgePath $Code
`;
  return new Response(script, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function connectScript(code: string, requestOrigin: string): Response {
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
  echo "Unsupported OS: \${OS}. Use Linux or macOS."
  exit 1
fi
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
echo "Downloading bridge for \${OS}-\${ARCH}..."
curl -fsSL "\${BASE_URL}/bin/\${BIN_NAME}" -o "\${TMPDIR}/\${BIN_NAME}"
chmod +x "\${TMPDIR}/\${BIN_NAME}"
BRIDGE_WS_URL="\${BASE_URL/http/ws}/ws" "\${TMPDIR}/\${BIN_NAME}" "\${CODE}"
`;
  return new Response(script, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
