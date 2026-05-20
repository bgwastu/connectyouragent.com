import { audit, createSession, getSession, listActiveSessions } from "./db.ts";
import { executeHttpCommand, getOrCreateSlot, isSessionCode, removeSlot } from "./relay.ts";

type SessionResponse = ReturnType<typeof toSessionResponse>;
const promptTemplate = await Bun.file("./server/templates/prompt.md").text();

/** Detect the effective origin (protocol + host) behind TLS-terminating proxies. */
function effectiveOrigin(req: Request): string {
  const proto = req.headers.get("X-Forwarded-Proto") === "https" ? "https" : "http";
  const host = req.headers.get("Host") || "localhost";
  return `${proto}://${host}`;
}

export function generateCode(): string {
  const adjectives = [
    "sage", "quiet", "brisk", "bright", "calm", "clever", "gentle", "honest", "lucky", "solar",
    "swift", "brave", "fresh", "grand", "happy", "jolly", "keen", "light", "merry", "noble",
    "proud", "rapid", "sharp", "smart", "solid", "sunny", "super", "vivid", "warm", "young",
    "azure", "bold", "cool", "crisp", "eager", "fancy", "gold", "green", "handy", "ideal",
    "jazzy", "kind", "lazy", "mellow", "neat", "pure", "ready", "rosy", "safe", "tidy",
    "agile", "amber", "blithe", "breezy", "cozy", "deft", "droll", "fiery", "fleet", "giddy",
    "jaunty", "lithe", "lofty", "nimble", "plucky", "quirky", "rustic", "serene", "silky", "sleek",
    "spry", "sturdy", "subtle", "suave", "wily", "witty", "zany", "zesty", "bubbly", "chirpy",
    "dandy", "dapper", "fluffy", "frisky", "glad", "perky", "snappy", "spiffy", "trim", "natty",
    "peppy", "plump", "pert", "prim", "snug", "bonny", "comely", "canny", "earnest", "frank",
  ];

  const nouns = [
    "daffodil", "henna", "cedar", "ember", "fig", "harbor", "ivy", "jasmine", "meadow", "willow",
    "acorn", "bamboo", "brook", "cliff", "coral", "cove", "crane", "dune", "flint", "grove",
    "hawk", "hollow", "lark", "lotus", "maple", "marsh", "mist", "oak", "pearl", "pine",
    "raven", "reed", "ridge", "stone", "swift", "thyme", "vale", "vine", "wolf", "yew",
    "alder", "aspen", "aster", "basil", "birch", "bloom", "briar", "clover", "cress", "elder",
    "fennel", "fern", "gorse", "heath", "holly", "juniper", "laurel", "lichen", "linden", "lupine",
    "mallow", "mimosa", "moss", "myrtle", "nettle", "orchid", "pansy", "papyrus", "phlox", "poppy",
    "primrose", "rhubarb", "saffron", "sorrel", "spruce", "sumac", "tansy", "thistle", "tulip", "anemone",
    "azalea", "begonia", "camellia", "dahlia", "forsythia", "gardenia", "hibiscus", "iris", "lavender", "lilac",
    "magnolia", "oleander", "wisteria", "yarrow", "zinnia", "foxglove", "bluebell", "campion", "gentian", "cowslip",
  ];

  const tails = [
    "antirust", "gab", "orbit", "signal", "anchor", "cobalt", "delta", "pixel", "raven", "topaz",
    "arc", "beacon", "bolt", "cipher", "crest", "drift", "echo", "flare", "forge", "frost",
    "glint", "haven", "helix", "horizon", "latch", "lens", "marble", "nexus", "onyx", "opal",
    "pioneer", "plume", "prism", "quartz", "quest", "rift", "scout", "shard", "spark", "spire",
    "surge", "talon", "tide", "trace", "vault", "vertex", "vigil", "vista", "warp", "zenith",
    "aegis", "alchemy", "archer", "badge", "banner", "blade", "blitz", "boulder", "cairn", "cobra",
    "comet", "corsair", "crescent", "dagger", "drake", "emblem", "falcon", "fathom", "gazelle", "glacier",
    "glimmer", "griffin", "halberd", "helm", "herald", "keystone", "lantern", "legacy", "mammoth", "mantle",
    "meteor", "monolith", "obelisk", "oracle", "paladin", "phantom", "pinnacle", "portal", "quiver", "relic",
    "rune", "scepter", "sentry", "spindle", "temple", "titan", "tower", "trident", "vanguard", "wyvern",
  ];

  // Rejection sampling eliminates modulo bias
  const pick = (items: string[]): string => {
    const max = Math.floor(2 ** 32 / items.length) * items.length;
    for (;;) {
      const rand = crypto.getRandomValues(new Uint32Array(1))[0]!;
      if (rand < max) return items[rand % items.length]!;
    }
  };

  // 4 random digits = 10,000 possibilities (13.3 bits)
  const digits = crypto.getRandomValues(new Uint32Array(1))[0]! % 10000;

  return `${pick(adjectives)}-${pick(nouns)}-${pick(tails)}${String(digits).padStart(4, "0")}`;
}

export function apiHandler(req: Request, url: URL): Response | Promise<Response> | null {
  const path = url.pathname;
  const method = req.method;
  const origin = effectiveOrigin(req);

  if (path === "/api/session" && (method === "GET" || method === "POST")) {
    const code = createUniqueSessionCode();
    createSession(code);
    getOrCreateSlot(code);
    audit(code, "system", "session_created");
    return json({
      code,
      status: "waiting",
      connect_url: origin ? `${origin}/c/${code}` : `/c/${code}`,
    });
  }

  if (path === "/api/sessions" && method === "GET") {
    return json(listActiveSessions());
  }

  const match = path.match(/^\/api\/session\/([a-z]+-[a-z]+-[a-z]+\d{4})(?:\/(run|cmd|disconnect|prompt(?:\.md)?))?$/);
  if (!match) return null;

  const code = match[1]!;
  const action = match[2] || "info";
  const session = getSession(code);
  if (!session) return notFound();

  if (action === "info" && method === "GET") {
    return json(toSessionResponse(session, origin));
  }

  if (action === "disconnect" && (method === "GET" || method === "POST")) {
    removeSlot(code, "user_disconnect");
    return json({ ok: true, code, status: "closed" });
  }

  if ((action === "prompt" || action === "prompt.md") && method === "GET") {
    return markdown(buildPrompt(toSessionResponse(session, origin), origin));
  }

  if ((action === "run" || action === "cmd") && (method === "GET" || method === "POST")) {
    return handleCommand(req, url, code, session.status, origin);
  }

  return null;
}

async function handleCommand(req: Request, url: URL, code: string, status: string, baseUrl?: string): Promise<Response> {
  if (!isSessionCode(code)) return json({ error: "Invalid session code" }, 400);
  if (status !== "active") return json({ error: "Agent not connected" }, 409);

  const cmd = await getCommand(req, url);
  if (!cmd) return json({ error: "Missing cmd. Use ?cmd=... for GET or JSON {\"cmd\":\"...\"}." }, 400);

  audit(code, "http", "command", cmd);
  try {
    const result = await executeHttpCommand(code, cmd);
    return json({
      ...result,
      session: code,
      run_url: baseUrl ? `${baseUrl}/api/session/${code}/run?cmd=` : `/api/session/${code}/run?cmd=`,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Command failed" }, 500);
  }
}

async function getCommand(req: Request, url: URL): Promise<string | null> {
  const queryCmd = url.searchParams.get("cmd") || url.searchParams.get("command");
  if (queryCmd?.trim()) return queryCmd;
  if (req.method !== "POST") return null;

  try {
    const body = await req.json() as { cmd?: unknown; command?: unknown };
    const cmd = body.cmd || body.command;
    return typeof cmd === "string" && cmd.trim() ? cmd : null;
  } catch {
    return null;
  }
}

function createUniqueSessionCode(): string {
  for (let attempts = 0; attempts < 20; attempts++) {
    const code = generateCode();
    if (!getSession(code)) return code;
  }
  throw new Error("Unable to allocate session code");
}

export function toSessionResponse(session: NonNullable<ReturnType<typeof getSession>>, baseUrl?: string) {
  return {
    code: session.code,
    status: session.status,
    agent_os: session.agent_os,
    agent_arch: session.agent_arch,
    agent_host: session.agent_host,
    agent_user: session.agent_user,
    agent_cwd: session.agent_cwd,
    agent_shell: session.agent_shell,
    agent_elevated: Boolean(session.agent_elevated),
    created_at: session.created_at,
    updated_at: session.updated_at,
    closed_at: session.closed_at,
    connect_url: baseUrl ? `${baseUrl}/c/${session.code}` : `/c/${session.code}`,
    prompt_url: baseUrl ? `${baseUrl}/c/${session.code}/prompt.md` : `/c/${session.code}/prompt.md`,
    run_url: baseUrl ? `${baseUrl}/api/session/${session.code}/run?cmd=` : `/api/session/${session.code}/run?cmd=`,
    capabilities: ["shell"],
  };
}

export function buildPrompt(session: SessionResponse, baseUrl?: string): string {
  const hasStatus = session.status === "active";
  const runUrl = baseUrl
    ? `${baseUrl}/api/session/${session.code}/run?cmd=`
    : `/api/session/${session.code}/run?cmd=`;
  return renderTemplate(promptTemplate, {
    code: session.code,
    status: session.status,
    remote: `${session.agent_user || "unknown"}@${session.agent_host || "unknown"}`,
    os_arch: `${session.agent_os || "unknown"}/${session.agent_arch || "unknown"}`,
    cwd: session.agent_cwd || "unknown",
    shell: session.agent_shell || "unknown",
    elevated: session.agent_elevated ? "yes" : "no",
    created_at: session.created_at,
    updated_at: session.updated_at,
    connection_status: hasStatus
      ? "The agent is connected and ready."
      : "The agent is not active yet. Wait until the user connects the machine before running commands.",
    run_url: runUrl,
  });
}

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => values[key] ?? "");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function markdown(data: string): Response {
  return new Response(data, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}
