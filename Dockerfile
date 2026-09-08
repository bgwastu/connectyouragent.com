FROM golang:1.23-bookworm AS bridgebuilder
WORKDIR /app
COPY scripts/build-bridge.sh scripts/
COPY bridge ./bridge
RUN sh scripts/build-bridge.sh

FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock* package-lock.json* tsconfig.json ./
RUN bun install
COPY public ./public
COPY server ./server
COPY --from=bridgebuilder /app/public/bin /app/public/bin
EXPOSE 8765
CMD ["bun", "run", "server/index.ts"]
