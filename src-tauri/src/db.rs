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
    // B-11 + 第五轮修复：schema 版本检查是纯只读，必须先于一切可写 PRAGMA
    // （journal_mode=WAL 会改库文件头）与 DDL/迁移执行——拒绝打开未来 schema 库时零写入：
    // 文件 hash、journal 模式与行数据全部保持原样。
    check_schema_not_newer(&conn)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(INIT_SQL)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 库已存在且 schema 版本高于本程序支持值时立即报错；全新库（无迁移表）直接放行。
fn check_schema_not_newer(conn: &Connection) -> rusqlite::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Ok(());
    }
    let current: i64 = conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| row.get(0))?;
    if current > DATA_SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidColumnName(format!(
            "数据库 schema {current} 比当前程序支持的 {DATA_SCHEMA_VERSION} 新：请先升级 OneLedger，不要用旧程序打开新库（回退请恢复与旧版本匹配的完整备份）"
        )));
    }
    Ok(())
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
    if version < 8 {
        let tx = conn.unchecked_transaction()?;
        add_column(&tx, "api_keys", "protected_token", "BLOB")?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![8, now_iso()])?;
        tx.commit()?;
        version = 8;
    }
    if version < 9 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS trusted_mcp_sources (
              key_id TEXT NOT NULL,
              source TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (key_id, source)
            );
            "#,
        )?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![9, now_iso()])?;
        tx.commit()?;
        version = 9;
    }
    if version < 10 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS scope_merge_operations (
              id TEXT PRIMARY KEY,
              from_scope_kind TEXT NOT NULL,
              from_scope_id TEXT NOT NULL,
              to_scope_kind TEXT NOT NULL,
              to_scope_id TEXT NOT NULL,
              moved_ids TEXT NOT NULL,
              moved_count INTEGER NOT NULL,
              source_breakdown TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              reverted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS scope_merge_ops_status
              ON scope_merge_operations(status, created_at);
            "#,
        )?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![10, now_iso()])?;
        tx.commit()?;
        version = 10;
    }
    if version < 11 {
        // v11：归并批次精确 ID 改存 scope_merge_operation_items 主键表，
        // 旧 v10 的 moved_ids 文本一次性回填进 item 表；原字段保留到兼容期结束。
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS scope_merge_operation_items (
              operation_id TEXT NOT NULL,
              inbox_id TEXT NOT NULL,
              PRIMARY KEY (operation_id, inbox_id)
            );
            "#,
        )?;
        backfill_merge_operation_items(&tx)?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![11, now_iso()])?;
        tx.commit()?;
        version = 11;
    }
    if version < 12 {
        // v12：B-05 给 inbox 加稳定来源键（同仓库不同文件同文不再是同一材料）；
        // C-02 给采集指纹加单调 touched_seq（同毫秒时间戳并列时按最近触碰排序）。
        let tx = conn.unchecked_transaction()?;
        add_column(&tx, "inbox", "source_key", "TEXT NOT NULL DEFAULT ''")?;
        add_column(&tx, "collect_fingerprints", "touched_seq", "INTEGER NOT NULL DEFAULT 0")?;
        tx.execute("UPDATE collect_fingerprints SET touched_seq = rowid WHERE touched_seq = 0", [])?;
        let max_seq: i64 = tx.query_row("SELECT COALESCE(MAX(touched_seq), 0) FROM collect_fingerprints", [], |row| row.get(0))?;
        tx.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('fp_seq', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![max_seq.to_string()],
        )?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)", params![12, now_iso()])?;
        tx.commit()?;
        version = 12;
    }
    if version < DATA_SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidColumnName(format!(
            "Database is behind schema {DATA_SCHEMA_VERSION}; update OneLedger."
        )));
    }
    if version > DATA_SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidColumnName(format!(
            "数据库 schema {version} 比当前程序支持的 {DATA_SCHEMA_VERSION} 新：请先升级 OneLedger"
        )));
    }
    verify_required_tables(conn)?;
    verify_merge_operation_integrity(conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS inbox_status_created ON inbox(queue_status, created_at);
         CREATE INDEX IF NOT EXISTS inbox_proposed_scope ON inbox(queue_status, scope_kind, scope_id, created_at);
         CREATE INDEX IF NOT EXISTS redaction_events_inbox ON redaction_events(inbox_id);
         CREATE INDEX IF NOT EXISTS inbox_source_key ON inbox(source, scope_kind, scope_id, source_key);
         CREATE INDEX IF NOT EXISTS collect_fp_touched ON collect_fingerprints(collector, source_key, rules_version, touched_seq);",
    )?;
    Ok(())
}

/// B-06：启动与导入共用的归并操作完整性校验——
/// moved_count 必须等于 distinct item 数；item 所属操作必须存在；新格式操作（moved_ids 为空）必须有批次明细。
/// 校验失败说明库已损坏或导入半途而废，启动即报错，不能带着不可撤销的操作继续运行。
pub fn verify_merge_operation_integrity(conn: &Connection) -> rusqlite::Result<()> {
    let mismatch: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scope_merge_operations o
         WHERE (o.moved_ids = '' AND (SELECT COUNT(DISTINCT s.inbox_id) FROM scope_merge_operation_items s WHERE s.operation_id = o.id) != o.moved_count)
            OR (o.moved_ids != '' AND EXISTS (SELECT 1 FROM scope_merge_operation_items s WHERE s.operation_id = o.id)
                AND (SELECT COUNT(DISTINCT s.inbox_id) FROM scope_merge_operation_items s WHERE s.operation_id = o.id) != o.moved_count)",
        [],
        |row| row.get(0),
    )?;
    if mismatch > 0 {
        return Err(rusqlite::Error::InvalidColumnName(format!(
            "{mismatch} 条归并操作的 moved_count 与批次明细数不一致，数据库可能已损坏或导入不完整；请从备份恢复"
        )));
    }
    let orphans: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scope_merge_operation_items s
         WHERE NOT EXISTS (SELECT 1 FROM scope_merge_operations o WHERE o.id = s.operation_id)",
        [],
        |row| row.get(0),
    )?;
    if orphans > 0 {
        return Err(rusqlite::Error::InvalidColumnName(format!(
            "{orphans} 条归并批次明细没有对应的操作记录（孤儿 item），数据库可能已损坏；请从备份恢复"
        )));
    }
    Ok(())
}

/// 把 v10 遗留的 moved_ids 文本拆分回填到 item 表；幂等（主键去重）。
fn backfill_merge_operation_items(conn: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, moved_ids FROM scope_merge_operations WHERE moved_ids != ''",
        )?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        mapped
    };
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO scope_merge_operation_items (operation_id, inbox_id) VALUES (?1, ?2)",
    )?;
    for (operation_id, moved_ids) in rows {
        for inbox_id in moved_ids.split('\u{1f}').filter(|item| !item.is_empty()) {
            stmt.execute(params![operation_id, inbox_id])?;
        }
    }
    Ok(())
}

/// 迁移完成后校验核心表齐全；缺表说明数据库损坏或不完整，启动即报错而不是运行中崩溃。
fn verify_required_tables(conn: &Connection) -> rusqlite::Result<()> {
    const REQUIRED: &[&str] = &[
        "memories",
        "inbox",
        "api_keys",
        "audit_log",
        "redaction_events",
        "redaction_archive",
        "sync_meta",
        "collect_fingerprints",
        "distill_drafts",
        "vault_items",
        "agents",
        "trusted_mcp_sources",
        "scope_merge_operations",
        "scope_merge_operation_items",
    ];
    for table in REQUIRED {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(rusqlite::Error::InvalidColumnName(format!("missing required table {table}: 数据库可能已损坏或不完整，请从备份恢复")));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_schema_upgrades_from_six_and_is_repeatable() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        migrate(&conn).expect("initial migrations");
        conn.execute("DELETE FROM schema_migrations WHERE version >= 7", []).expect("restore schema 6 marker");
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

    #[test]
    fn trusted_mcp_sources_upgrade_from_eight_and_roundtrip() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        migrate(&conn).expect("initial migrations");
        conn.execute("DELETE FROM schema_migrations WHERE version >= 9", []).expect("restore schema 8 marker");
        conn.execute_batch("DROP TABLE trusted_mcp_sources;").expect("restore schema 8 tables");
        migrate(&conn).expect("upgrade to nine");
        migrate(&conn).expect("repeat upgrade");
        let versions: i64 = conn.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version = 9", [], |row| row.get(0)).expect("marker");
        assert_eq!(versions, 1);
        conn.execute(
            "INSERT INTO api_keys (id, name, token_hash, token_prefix, scopes, tools, created_at) VALUES ('key_t', '测试密钥', 'hash_t', 'ol_t', 'global', 'memory.search', 'now')",
            [],
        ).expect("api key");
        assert!(!crate::store::mcp_source_trusted(&conn, "key_t", "127.0.0.1").expect("trusted check"));
        crate::store::trust_mcp_source(&conn, "key_t", "127.0.0.1").expect("trust");
        crate::store::trust_mcp_source(&conn, "key_t", "127.0.0.1").expect("trust again is idempotent");
        assert!(crate::store::mcp_source_trusted(&conn, "key_t", "127.0.0.1").expect("trusted check"));
        assert!(!crate::store::mcp_source_trusted(&conn, "key_t", "127.0.0.2").expect("other source"));
        let rows = crate::store::list_trusted_mcp_sources(&conn).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key_name, "测试密钥");
        assert_eq!(rows[0].source, "127.0.0.1");
        assert!(!rows[0].created_at.is_empty());
        assert!(crate::store::delete_trusted_mcp_source(&conn, "key_t", "127.0.0.1").expect("forget"));
        assert!(!crate::store::mcp_source_trusted(&conn, "key_t", "127.0.0.1").expect("forgotten"));
        assert!(!crate::store::delete_trusted_mcp_source(&conn, "key_t", "127.0.0.1").expect("second forget"));
    }

    #[test]
    fn old_hash_only_keys_survive_protected_token_migration() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        let old_hash = crate::util::hash_token("ol_existing-fixture");
        conn.execute("INSERT INTO api_keys (id, name, token_hash, token_prefix, scopes, tools, created_at) VALUES ('key_old', 'existing', ?1, 'ol_old', 'global', 'memory.search', 'now')", [old_hash.as_str()]).expect("old key");
        migrate(&conn).expect("migrate");
        migrate(&conn).expect("repeat");
        let key = crate::store::find_key_by_id(&conn, "key_old").expect("read key").expect("existing key");
        assert_eq!(key.name, "existing");
        assert!(key.protected_token.is_none());
        assert!(crate::store::find_key_by_hash(&conn, &old_hash).expect("auth").is_some());
        #[cfg(windows)]
        {
            let protected = crate::vault::protect_key("key_old", "ol_existing-fixture").expect("protect old key");
            assert!(crate::store::protect_existing_key(&conn, "key_old", &protected).expect("upgrade old key"));
            assert!(!crate::store::protect_existing_key(&conn, "key_old", &protected).expect("do not overwrite"));
            assert!(crate::store::find_key_by_hash(&conn, &old_hash).expect("auth after upgrade").is_some());
        }
    }

    #[cfg(windows)]
    #[test]
    fn newly_issued_key_remains_hash_authenticated_and_can_be_unprotected_locally() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        migrate(&conn).expect("migrate");
        let issued = crate::service::MemoryService::issue_key(&conn, "test-agent").expect("issue");
        let token = issued["token"].as_str().expect("token");
        let key = crate::store::find_key_by_hash(&conn, &crate::util::hash_token(token)).expect("lookup").expect("stored key");
        let protected = key.protected_token.expect("protected token");
        assert!(!protected.windows(token.len()).any(|part| part == token.as_bytes()));
        assert_eq!(crate::vault::unprotect_key(&key.id, &protected).expect("unprotect"), token);
    }

    #[test]
    fn upgrade_from_v10_backfills_operation_items_and_keeps_moved_ids() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        migrate(&conn).expect("initial migrations");
        // 造一个 v10 形态的操作记录：只有 moved_ids 文本，没有 item 表内容
        conn.execute("DELETE FROM schema_migrations WHERE version >= 11", []).expect("restore v10 marker");
        conn.execute_batch("DROP TABLE scope_merge_operation_items;").expect("restore v10 tables");
        conn.execute(
            "INSERT INTO scope_merge_operations (id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_ids, moved_count, source_breakdown, status, created_at)
             VALUES ('sm_old', 'project', 'bad\\path', 'project', 'Target', 'in_a\u{1f}in_b\u{1f}in_c', 3, '{}', 'applied', 'now')",
            [],
        ).expect("v10 operation");
        migrate(&conn).expect("upgrade to eleven");
        migrate(&conn).expect("repeat upgrade is idempotent");
        let items: i64 = conn
            .query_row("SELECT COUNT(*) FROM scope_merge_operation_items WHERE operation_id = 'sm_old'", [], |row| row.get(0))
            .expect("items");
        assert_eq!(items, 3);
        // 原字段保留到兼容期结束
        let moved: String = conn
            .query_row("SELECT moved_ids FROM scope_merge_operations WHERE id = 'sm_old'", [], |row| row.get(0))
            .expect("moved_ids kept");
        assert_eq!(moved, "in_a\u{1f}in_b\u{1f}in_c");
        let marker: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations WHERE version = 11", [], |row| row.get(0))
            .expect("marker");
        assert_eq!(marker, 1);
        // 回填后的操作可被 item 表撤销语义读取
        let op = crate::store::get_merge_operation(&conn, "sm_old").expect("read").expect("op");
        assert_eq!(op.batch_ids(), vec!["in_a".to_string(), "in_b".to_string(), "in_c".to_string()]);
    }

    #[test]
    fn upgrade_from_v9_creates_merge_tables() {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(INIT_SQL).expect("base schema");
        migrate(&conn).expect("initial migrations");
        conn.execute("DELETE FROM schema_migrations WHERE version >= 10", []).expect("restore v9 marker");
        conn.execute_batch("DROP TABLE scope_merge_operations; DROP TABLE scope_merge_operation_items; DROP INDEX IF EXISTS scope_merge_ops_status;").expect("restore v9 tables");
        migrate(&conn).expect("upgrade from nine");
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('scope_merge_operations', 'scope_merge_operation_items')",
                [],
                |row| row.get(0),
            )
            .expect("tables");
        assert_eq!(tables, 2);
    }

    #[test]
    fn missing_required_table_is_detected_on_open() {
        let dir = std::env::temp_dir().join(format!("oneledger-dbtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("broken.db");
        {
            let conn = open_db(path.to_str().expect("path")).expect("open");
            drop(conn);
        }
        {
            let conn = Connection::open(&path).expect("reopen raw");
            conn.execute_batch("DROP TABLE scope_merge_operation_items;").expect("break schema");
        }
        let result = open_db(path.to_str().expect("path"));
        assert!(result.is_err(), "missing table must fail loudly");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 第五轮修复：版本只读检查先于一切可写 PRAGMA——拒绝未来 schema 库时零写入：
    /// 文件字节不变（不被改成 WAL）、journal 模式保持 delete、行数据原样、句柄已释放。
    #[test]
    fn future_schema_rejection_performs_zero_writes_and_releases_the_handle() {
        let dir = std::env::temp_dir().join(format!("oneledger-dbtest-future-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("future.db");
        {
            let seed = Connection::open(&path).expect("seed");
            seed.execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations VALUES (13, 'synthetic');
                 CREATE TABLE keepsake (note TEXT NOT NULL);
                 INSERT INTO keepsake VALUES ('迁移前数据必须原样保留');
                 PRAGMA journal_mode = DELETE;",
            )
            .expect("seed future schema db");
        }
        let before = fs::read(&path).expect("read before");
        let result = open_db(path.to_str().expect("path"));
        assert!(result.is_err(), "future schema must be rejected");
        let err = result.err().expect("error").to_string();
        assert!(err.contains("比当前程序支持"), "error must mention schema support: {err}");
        let after = fs::read(&path).expect("read after");
        assert_eq!(before, after, "file bytes must stay identical (no WAL header rewrite)");
        // 句柄已释放：库文件可被重命名（Windows 上句柄未释放时重命名会失败）
        let moved = dir.join("future-moved.db");
        fs::rename(&path, &moved).expect("handle released (rename works)");
        fs::rename(&moved, &path).expect("restore path");
        // journal 模式保持 delete，数据完整
        let probe = Connection::open(&path).expect("reopen after rejection");
        let mode: String = probe.query_row("PRAGMA journal_mode", [], |row| row.get(0)).expect("journal mode");
        assert_eq!(mode, "delete");
        let note: String = probe.query_row("SELECT note FROM keepsake", [], |row| row.get(0)).expect("keepsake row");
        assert!(note.contains("原样保留"));
        drop(probe);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 第六轮修复：schema_migrations 表存在但结构损坏（缺 version 列）时，
    /// 版本检查 SQL 抛错必须同样失败关闭：连接被 Drop 释放句柄、零写入。
    #[test]
    fn malformed_schema_migrations_rejection_releases_the_handle_and_performs_zero_writes() {
        let dir = std::env::temp_dir().join(format!("oneledger-dbtest-malformed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("malformed.db");
        {
            let seed = Connection::open(&path).expect("seed");
            seed.execute_batch(
                "CREATE TABLE schema_migrations (foo TEXT NOT NULL);
                 CREATE TABLE keepsake (note TEXT NOT NULL);
                 INSERT INTO keepsake VALUES ('迁移前数据必须原样保留');
                 PRAGMA journal_mode = DELETE;",
            )
            .expect("seed malformed db");
        }
        let before = fs::read(&path).expect("read before");
        let result = open_db(path.to_str().expect("path"));
        assert!(result.is_err(), "malformed schema_migrations must be rejected");
        let after = fs::read(&path).expect("read after");
        assert_eq!(before, after, "file bytes must stay identical");
        // 句柄已释放：库文件可被重命名（Windows 上句柄未释放时重命名会失败）
        let moved = dir.join("malformed-moved.db");
        fs::rename(&path, &moved).expect("handle released (rename works)");
        fs::rename(&moved, &path).expect("restore path");
        let probe = Connection::open(&path).expect("reopen after rejection");
        let mode: String = probe.query_row("PRAGMA journal_mode", [], |row| row.get(0)).expect("journal mode");
        assert_eq!(mode, "delete");
        let note: String = probe.query_row("SELECT note FROM keepsake", [], |row| row.get(0)).expect("keepsake row");
        assert!(note.contains("原样保留"));
        drop(probe);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
