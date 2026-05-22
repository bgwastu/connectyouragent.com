# CYA

Connect Your Agent. Give an AI agent temporary, user-approved command access to a machine.

CYA starts an in-memory session, shows a one-line install command for the target machine, and gives you a prompt URL to paste into Claude Code, Codex, OpenClaw, or another agent. The bridge connects back over WebSocket and executes one command at a time through the HTTP API.

## Quick Start

```sh
bun install
bun dev
```

Open `http://localhost:8765`, create a session, run the displayed command on the target machine, then paste the generated prompt into your agent.

The bridge binaries are built with Go, so local development needs **Go 1.22+**.

## Docker

```sh
docker build -t cya .
docker run --rm -p 8765:8765 -e BASE_URL=http://localhost:8765 cya
```

## Supported Targets

- macOS Intel / Apple Silicon
- Linux x64 / arm64
- OpenWrt-style Linux MIPS / MIPS64, big-endian and little-endian
- Windows x64

## How It Works

1. Browser creates a short-lived session code.
2. Target machine runs the install command for its OS.
3. The Go bridge connects to `/ws` and joins the session.
4. Agents call `/api/session/:code/run` with `cmd`, `cmd_b64`, and optional `timeout`.
5. The response includes merged stdout/stderr, `exit_code`, and `truncated`.

Sessions are in-memory only. Nothing is persisted by the server.

## Development

```sh
bun run typecheck
bun test
(cd bridge && go test ./...)
bun run build
```

`bun run build` compiles bridge binaries into `public/bin/`.
