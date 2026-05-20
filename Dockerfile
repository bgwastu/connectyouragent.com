FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY server ./server
COPY bridge ./bridge
RUN bun run build:bridge

FROM oven/bun:1-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY public ./public
COPY server ./server
COPY --from=builder /app/public/bin /app/public/bin
EXPOSE 8765
CMD ["bun", "run", "server/src/index.ts"]
