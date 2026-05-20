CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY,
  status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting', 'active', 'closed')),
  agent_os TEXT,
  agent_arch TEXT,
  agent_host TEXT,
  agent_user TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_code TEXT NOT NULL,
  role TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_code);
