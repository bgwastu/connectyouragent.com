# Connect Your Agent (CYA)

Temporary shell access for AI agents.

## Run locally (Docker)

```sh
docker build -t cya . && docker run --rm -p 8765:8765 -e BASE_URL=http://localhost:8765 cya
```

Open http://localhost:8765 and create a session.

## Development

```sh
bun install
bun dev
```