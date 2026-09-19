use crate::util::{now_iso, DATA_SCHEMA_VERSION};
use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;

const INIT_SQL: &str = r#"
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
  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_status_updated ON memories(status, updated_at);
  CREATE INDEX IF NOT EXISTS memories_hash ON memories(content_hash);
"#;

pub fn open_db(sqlite_path: &str) -> rusqlite::Result<Connection> {
    if let Some(parent) = Path::new(sqlite_path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let conn = Connection::open(sqlite_path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(INIT_SQL)?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| row.get(0))
        .unwrap_or(0);
    let mut version = current;
    if version < 1 {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![1, now_iso()],
        )?;
        version = 1;
    }
    if version < 2 {
        add_column(conn, "inbox", "queue_status", "TEXT NOT NULL DEFAULT 'proposed'")?;
        add_column(conn, "inbox", "conflict_ids", "TEXT NOT NULL DEFAULT ''")?;
        add_column(conn, "memories", "superseded_by", "TEXT")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![2, now_iso()],
        )?;
        version = 2;
    }
    if version < 3 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agents (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              kind TEXT NOT NULL,
              builtin INTEGER NOT NULL,
              enabled INTEGER NOT NULL,
              root_path TEXT NOT NULL,
              last_scanned_at TEXT,
              last_scanned_files INTEGER NOT NULL DEFAULT 0,
              last_ingested INTEGER NOT NULL DEFAULT 0,
              last_queued INTEGER NOT NULL DEFAULT 0,
              last_redacted INTEGER NOT NULL DEFAULT 0,
              last_error TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL
            );
            "#,
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![3, now_iso()],
        )?;
        version = 3;
    }
    if version < DATA_SCHEMA_VERSION {
        panic!("Database is behind schema {DATA_SCHEMA_VERSION}; update OneLedger.");
    }
    Ok(())
}

fn add_column(conn: &Connection, table: &str, column: &str, definition: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|item| item.ok())
        .any(|name| name == column);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    }
    Ok(())
}
