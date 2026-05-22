# CYA

AI agent shell relay. **Dev:** `bun install && bun dev` (needs **Go ≥ 1.22** so the bridge binaries can compile into `public/bin/`).

**Docker:** `docker build -t cya . && docker run --rm -p 8765:8765 -e BASE_URL=http://localhost:8765 cya`
