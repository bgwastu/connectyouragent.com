import type { ServerWebSocket } from "bun";
import { PORT, HOST, CLEANUP_INTERVAL } from "./config.ts";
import { cleanupStaleSlots, handleJoin, handleMessage, handleDisconnect } from "./relay.ts";
import { apiHandler } from "./api.ts";
import { pagesHandler } from "./pages.ts";
import { cleanupOldSessions } from "./db.ts";
import { SESSION_MAX_AGE, SESSION_IDLE_TIMEOUT } from "./config.ts";

// Static file serving for bootstrap.sh and CYA bridge binaries
async function staticHandler(path: string): Promise<Response | null> {
  if (path === "/bootstrap.sh") {
    const file = Bun.file("./public/bootstrap.sh");
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": "text/plain" } });
    }
  }
  if (path.startsWith("/bin/")) {
    const fileName = path.slice(5);
    if (/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
      const file = Bun.file(`./public/bin/${fileName}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
    }
  }
  return null;
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    const apiRes = apiHandler(req, url);
    if (apiRes) return apiRes;

    // Page routes
    const pageRes = pagesHandler(req, url);
    if (pageRes) return pageRes;

    // Static files
    return staticHandler(url.pathname).then((res) => res || new Response("Not found", { status: 404 }));
  },
  websocket: {
    open(ws: ServerWebSocket<unknown>) {},
    message(ws: ServerWebSocket<unknown>, message) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }
      if (msg.type === "join") {
        handleJoin(ws, msg);
      } else {
        handleMessage(ws, text);
      }
    },
    close(ws: ServerWebSocket<unknown>) {
      handleDisconnect(ws);
    },
  },
});

console.log(`Connect Your Agent (CYA) listening on ${HOST}:${PORT}`);
console.log(`CYA routes: /, /c/{code}, /c/{code}/prompt, /api/session/{code}/run?cmd=...`);

// Cleanup timer
setInterval(() => {
  const closed = cleanupOldSessions(SESSION_MAX_AGE, SESSION_IDLE_TIMEOUT);
  const staleSlots = cleanupStaleSlots();
  if (closed > 0) console.log(`Cleaned up ${closed} stale sessions`);
  if (staleSlots.length > 0) console.log(`Closed stale in-memory sessions: ${staleSlots.join(", ")}`);
}, CLEANUP_INTERVAL * 1000);
