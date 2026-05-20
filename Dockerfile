# Build stage: compile agent binaries
FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY server ./server
COPY agent ./agent
RUN mkdir -p public/bin && bun build --compile --target=bun-linux-x64 --outfile=public/bin/bridge-agent-linux-x64 ./agent/agent.ts

# Runtime stage
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY public ./public
COPY server ./server
COPY --from=builder /app/public/bin/bridge-agent-linux-x64 /app/public/bin/bridge-agent-linux-x64
RUN mkdir -p data
EXPOSE 8765
CMD ["bun", "run", "server/src/index.ts"]
