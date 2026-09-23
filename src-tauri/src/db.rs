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
    if version < 4 {
        conn.execute_batch(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
              title, body, content='memories', content_rowid='rowid', tokenize='trigram'
            );
            CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
              INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
              INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
            END;
            INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
            "#,
        )?;
        conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![4, now_iso()])?;
        version = 4;
    }
    if version < 5 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS collect_fingerprints (
              id TEXT PRIMARY KEY,
              collector TEXT NOT NULL,
              source_key TEXT NOT NULL,
              scope_kind TEXT NOT NULL,
              scope_id TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              rules_version INTEGER NOT NULL,
              last_status TEXT NOT NULL,
              first_seen_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              UNIQUE (collector, source_key, scope_kind, scope_id, content_hash, rules_version)
            );
            CREATE INDEX IF NOT EXISTS collect_fp_latest
              ON collect_fingerprints(collector, source_key, scope_kind, scope_id, rules_version, last_seen_at);
            "#,
        )?;
        conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![5, now_iso()])?;
        version = 5;
    }
    if version < 6 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS distill_drafts (
              id TEXT PRIMARY KEY,
              scope_kind TEXT NOT NULL,
              scope_id TEXT NOT NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              source_ids TEXT NOT NULL,
              source_fingerprints TEXT NOT NULL,
              expected_rev INTEGER NOT NULL,
              provider TEXT NOT NULL,
              model TEXT NOT NULL,
              status TEXT NOT NULL,
              stale_reason TEXT NOT NULL DEFAULT '',
              error TEXT NOT NULL DEFAULT '',
              attempts INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS distill_drafts_scope
              ON distill_drafts(scope_kind, scope_id, status, updated_at);
            "#,
        )?;
        conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![6, now_iso()])?;
        version = 6;
    }
    if version < 7 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS vault_items (
              id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              scope_kind TEXT NOT NULL,
              scope_id TEXT NOT NULL,
              protected_value BLOB NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS vault_items_scope
              ON vault_items(scope_kind, scope_id, updated_at);
            "#,
        )?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![7, now_iso()])?;
        tx.commit()?;
        version = 7;
    }
    if version < DATA_SCHEMA_VERSION {
        panic!("Database is behind schema {DATA_SCHEMA_VERSION}; update OneLedger.");
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS inbox_status_created ON inbox(queue_status, created_at);")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_schema_upgrades_from_six_and_is_repeatable() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        migrate(&conn).expect("initial migrations");
        conn.execute("DELETE FROM schema_migrations WHERE version = 7", []).expect("restore schema 6 marker");
        conn.execute_batch("DROP TABLE vault_items; DROP INDEX IF EXISTS vault_items_scope;").expect("restore schema 6 tables");
        migrate(&conn).expect("upgrade to seven");
        migrate(&conn).expect("repeat upgrade");
        let versions: i64 = conn.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version = 7", [], |row| row.get(0)).expect("marker");
        assert_eq!(versions, 1);
        conn.execute(
            "INSERT INTO vault_items (id, label, scope_kind, scope_id, protected_value, created_at, updated_at) VALUES ('vault_test', '测试凭据', 'project', 'OneLedger', ?1, 'now', 'now')",
            [vec![1_u8, 2, 3]],
        ).expect("vault table");
    }
}
