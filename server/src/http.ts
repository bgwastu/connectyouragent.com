/** Detect the effective origin (protocol + host) behind TLS-terminating proxies. */
export function effectiveOrigin(req: Request): string {
  const proto = req.headers.get("X-Forwarded-Proto") === "https" ? "https" : "http";
  const host = req.headers.get("Host") || "localhost";
  return `${proto}://${host}`;
}

// Cache-busting headers (CDN + browser)
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Surrogate-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
} as const;

export const NO_CACHE = NO_CACHE_HEADERS;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...NO_CACHE_HEADERS,
    },
  });
}

export function markdown(data: string): Response {
  return new Response(data, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...NO_CACHE_HEADERS,
    },
  });
}

export function html(data: string): Response {
  return new Response(data, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function notFound(): Response {
  return json({ error: "Not found" }, 404);
}
