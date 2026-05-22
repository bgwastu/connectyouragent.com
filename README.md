# Connect Your Agent (CYA)

CYA gives an AI agent temporary, user-approved command access to a machine.

Start a session, run the displayed install command on the target machine, then paste the generated prompt into Claude Code, Codex, OpenClaw, or another agent. Sessions are in-memory only and commands run one at a time.

## Quick Start

```sh
bun install
bun dev
```

Open `http://localhost:8765`, create a session, run the displayed command on the target machine, then paste the generated prompt into your agent.

## Docker

```sh
docker build -t cya .
docker run --rm -p 8765:8765 -e BASE_URL=http://localhost:8765 cya
```

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

Local development needs Bun and Go 1.22+. `bun run build` compiles bridge binaries into `public/bin/`.
