# Connect Your Agent (CYA)

Temporary shell access for any AI agent.

`BASE_URL` and `WS_URL` are required.

Run with Docker:

```sh
docker build -t cya . && docker run --rm -p 8765:8765 -v "$PWD/data:/app/data" -e BASE_URL=http://localhost:8765 -e WS_URL=ws://localhost:8765/ws cya
```

Open http://localhost:8765 and create a session.
