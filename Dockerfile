# Build stage: compile bridge binaries
FROM oven/bun:1 as builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY server ./server
COPY bridge ./bridge
RUN bun run build:bridge

# Runtime stage
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY migrations ./migrations
COPY public ./public
COPY server ./server
COPY --from=builder /app/public/bin /app/public/bin
RUN mkdir -p data
EXPOSE 8765
CMD ["bun", "run", "server/src/index.ts"]
