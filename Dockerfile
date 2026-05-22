FROM golang:1.23-bookworm AS bridgebuilder
WORKDIR /app
COPY scripts/build-bridge.sh scripts/
COPY bridge ./bridge
RUN sh scripts/build-bridge.sh

FROM oven/bun:1-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY server ./server
RUN mkdir -p public/bin
COPY --from=bridgebuilder /app/public/bin /app/public/bin
EXPOSE 8765
CMD ["bun", "run", "server/index.ts"]
