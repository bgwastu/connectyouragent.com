import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/bridge.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");

// Run migrations
const initSql = await Bun.file("./migrations/001_init.sql").text();
db.exec(initSql);
try { db.exec("ALTER TABLE sessions ADD COLUMN agent_cwd TEXT;"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN agent_shell TEXT;"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN agent_elevated INTEGER DEFAULT 0;"); } catch {}

export interface SessionRow {
  code: string;
  status: "waiting" | "active" | "closed";
  agent_os: string | null;
  agent_arch: string | null;
  agent_host: string | null;
  agent_user: string | null;
  agent_cwd: string | null;
  agent_shell: string | null;
  agent_elevated: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export function createSession(code: string) {
  db.prepare("INSERT INTO sessions (code) VALUES (?)").run(code);
}

export function getSession(code: string) {
  return db
    .query<SessionRow, [string]>(
      "SELECT * FROM sessions WHERE code = ?"
    )
    .get(code);
}

export function updateSessionStatus(code: string, status: string) {
  db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE code = ?").run(status, code);
}

export function setAgentMeta(code: string, os: string, arch: string, host: string, user: string, cwd?: string, shell?: string, elevated = false) {
  db.prepare("UPDATE sessions SET agent_os = ?, agent_arch = ?, agent_host = ?, agent_user = ?, agent_cwd = ?, agent_shell = ?, agent_elevated = ?, updated_at = datetime('now') WHERE code = ?").run(os, arch, host, user, cwd || null, shell || null, elevated ? 1 : 0, code);
}

export function closeSession(code: string) {
  db.prepare("UPDATE sessions SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE code = ?").run(code);
}

export function listActiveSessions() {
  return db.query<{ code: string; status: string; created_at: string }, []>("SELECT code, status, created_at FROM sessions WHERE status != 'closed' ORDER BY created_at DESC").all();
}

export function audit(sessionCode: string, role: string, event: string, payload?: string) {
  db.prepare("INSERT INTO audit_log (session_code, role, event, payload) VALUES (?, ?, ?, ?)").run(sessionCode, role, event, payload || null);
}

export function touchSession(code: string) {
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE code = ?").run(code);
}

export function cleanupOldSessions(maxAgeSeconds: number, idleSeconds: number) {
  const stmt = db.prepare(`
    UPDATE sessions SET status = 'closed', closed_at = datetime('now')
    WHERE status != 'closed'
    AND (
      unixepoch('now') - unixepoch(created_at) > ?
      OR (
        unixepoch('now') - unixepoch(updated_at) > ?
        AND status = 'waiting'
      )
    )
  `);
  const result = stmt.run(maxAgeSeconds, idleSeconds);
  return result.changes;
}
