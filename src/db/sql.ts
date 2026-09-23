export const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    rev INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    origin_node TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    forgotten_at TEXT
  );

  CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    redacted INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    tools TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS redaction_events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    hit_type TEXT NOT NULL,
    inbox_id TEXT
  );

  CREATE TABLE IF NOT EXISTS redaction_archive (
    day TEXT NOT NULL,
    hit_type TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, hit_type)
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS memories_status_updated ON memories(status, updated_at);
  CREATE INDEX IF NOT EXISTS memories_hash ON memories(content_hash);
  CREATE INDEX IF NOT EXISTS redactions_at ON redaction_events(at);
  CREATE INDEX IF NOT EXISTS inbox_dedupe_prefix ON inbox(source, scope_kind, scope_id, substr(body, 1, 128));
`;
