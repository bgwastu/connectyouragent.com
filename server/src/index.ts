import type { ServerWebSocket } from "bun";
import {
  PORT,
  HOST,
} from "./config.ts";
import { handleJoin, handleMessage, handleDisconnect } from "./relay.ts";
import { apiHandler } from "./api.ts";
import { pagesHandler } from "./pages.ts";
import { NO_CACHE } from "./http.ts";

async function staticHandler(path: string): Promise<Response | null> {
  if (path.startsWith("/bin/")) {
    const fileName = path.slice(5);
    if (/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
      const file = Bun.file(`./public/bin/${fileName}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "application/octet-stream", ...NO_CACHE },
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

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const apiRes = apiHandler(req, url);
    if (apiRes) return apiRes;

    const pageRes = pagesHandler(req, url);
    if (pageRes) return pageRes;

    return staticHandler(url.pathname).then(
      (res) => res || new Response("Not found", { status: 404 }),
    );
  },
  websocket: {
    open(_ws: ServerWebSocket<unknown>) {},
    message(ws: ServerWebSocket<unknown>, message) {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
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

console.log(`listening on ${HOST}:${PORT}`);
