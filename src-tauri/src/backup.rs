//! Unified backup file: one JSON document carries the whole ledger database.
//! Export and import both speak this exact format (`kind: oneledger-backup`).
//! The desktop endpoints dump every table; the MCP export carries the same
//! format restricted to the shareable memory subset (no inbox, no vault
//! ciphertext, no key material, no secret/pii rows).

use crate::util::{now_iso, APP_VERSION};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

pub const BACKUP_KIND: &str = "oneledger-backup";
pub const FORMAT_VERSION: i64 = 1;

type Rows = Vec<Map<String, Value>>;

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { BASE64_ALPHABET[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_ALPHABET[triple as usize & 63] as char } else { '=' });
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for ch in text.bytes() {
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        acc = (acc << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn blob_to_json(bytes: &[u8]) -> Value {
    json!({ "$base64": base64_encode(bytes) })
}

fn json_to_blob(value: &Value) -> Option<Vec<u8>> {
    let text = value.get("$base64")?.as_str()?;
    base64_decode(text)
}

fn cell_to_json(cell: ValueRef<'_>, blob_columns: &[&str], name: &str) -> Value {
    match cell {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(v) => json!(v),
        ValueRef::Real(v) => json!(v),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => {
            if blob_columns.contains(&name) {
                blob_to_json(b)
            } else {
                json!(String::from_utf8_lossy(b))
            }
        }
    }
}

fn dump_rows(conn: &Connection, sql: &str, blob_columns: &[&str]) -> Result<Rows, String> {
    let mut stmt = conn.prepare(sql).map_err(|_| format!("无法读取表：{sql}"))?;
    let names: Vec<String> = (0..stmt.column_count())
        .map(|index| stmt.column_name(index).unwrap_or("").to_string())
        .collect();
    let rows = stmt
        .query_map([], |row| {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let cell = row
                    .get_ref(index)
                    .map_err(|_| rusqlite::Error::InvalidColumnName(name.clone()))?;
                object.insert(name.clone(), cell_to_json(cell, blob_columns, name));
            }
            Ok(object)
        })
        .map_err(|_| format!("无法读取表：{sql}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| "无法读取备份数据".to_string())
}

fn insert_rows(conn: &Connection, sql: &str, rows: &[Value], blob_columns: &[&str]) -> Result<usize, String> {
    let mut applied = 0;
    for row in rows {
        let Some(fields) = row.as_object() else { continue };
        let columns: Vec<String> = fields.keys().cloned().collect();
        let placeholders: Vec<String> = (1..=columns.len()).map(|index| format!("?{index}")).collect();
        let statement = sql
            .replace("{columns}", &columns.join(", "))
            .replace("{values}", &placeholders.join(", "));
        let mut stmt = conn.prepare(&statement).map_err(|_| format!("无法写入表：{statement}"))?;
        let params: Vec<rusqlite::types::Value> = columns
            .iter()
            .map(|column| {
                let value = &fields[column.as_str()];
                if blob_columns.contains(&column.as_str()) {
                    json_to_blob(value)
                        .map(rusqlite::types::Value::Blob)
                        .unwrap_or(rusqlite::types::Value::Null)
                } else {
                    match value {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::Bool(v) => rusqlite::types::Value::Integer(*v as i64),
                        Value::Number(v) => {
                            if let Some(i) = v.as_i64() {
                                rusqlite::types::Value::Integer(i)
                            } else {
                                rusqlite::types::Value::Real(v.as_f64().unwrap_or(0.0))
                            }
                        }
                        Value::String(v) => rusqlite::types::Value::Text(v.clone()),
                        other => rusqlite::types::Value::Text(other.to_string()),
                    }
                }
            })
            .collect();
        applied += stmt
            .execute(rusqlite::params_from_iter(params))
            .map_err(|error| format!("无法写入备份数据：{error}"))?;
    }
    Ok(applied)
}

const MEMORIES_COLUMNS: &str =
    "id, rev, title, body, scope_kind, scope_id, sensitivity, status, source, origin_node, content_hash, created_at, updated_at, forgotten_at, superseded_by";
const INBOX_COLUMNS: &str =
    "id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids";
const API_KEY_COLUMNS: &str =
    "id, name, token_hash, token_prefix, protected_token, scopes, tools, created_at, last_used_at";
const AGENT_COLUMNS: &str =
    "id, name, kind, builtin, enabled, root_path, last_scanned_at, last_scanned_files, last_ingested, last_queued, last_redacted, last_error, created_at";

/// 全量备份：账本数据库里的每一张表都进同一个文件。config.json 是设置文件，不在备份内。
pub fn export_backup(conn: &Connection) -> Result<Value, String> {
    let data = json!({
        "memories": dump_rows(conn, &format!("SELECT {MEMORIES_COLUMNS} FROM memories ORDER BY rowid"), &[])?,
        "inbox": dump_rows(conn, &format!("SELECT {INBOX_COLUMNS} FROM inbox ORDER BY rowid"), &[])?,
        "vaultItems": dump_rows(conn, "SELECT id, label, scope_kind, scope_id, protected_value, created_at, updated_at FROM vault_items ORDER BY rowid", &["protected_value"])?,
        "apiKeys": dump_rows(conn, &format!("SELECT {API_KEY_COLUMNS} FROM api_keys ORDER BY rowid"), &["protected_token"])?,
        "agents": dump_rows(conn, &format!("SELECT {AGENT_COLUMNS} FROM agents ORDER BY rowid"), &[])?,
        "redactionEvents": dump_rows(conn, "SELECT id, at, source, hit_type, inbox_id FROM redaction_events ORDER BY rowid", &[])?,
        "redactionArchive": dump_rows(conn, "SELECT day, hit_type, count FROM redaction_archive ORDER BY day", &[])?,
        "collectFingerprints": dump_rows(conn, "SELECT id, collector, source_key, scope_kind, scope_id, content_hash, rules_version, last_status, first_seen_at, last_seen_at FROM collect_fingerprints ORDER BY rowid", &[])?,
        "distillDrafts": dump_rows(conn, "SELECT id, scope_kind, scope_id, title, body, source_ids, source_fingerprints, expected_rev, provider, model, status, stale_reason, error, attempts, created_at, updated_at FROM distill_drafts ORDER BY rowid", &[])?,
        "trustedMcpSources": dump_rows(conn, "SELECT key_id, source, created_at FROM trusted_mcp_sources ORDER BY rowid", &[])?,
        "auditLog": dump_rows(conn, "SELECT id, at, actor, action, detail FROM audit_log ORDER BY at DESC LIMIT 5000", &[])?,
        "syncCursor": conn.query_row("SELECT value FROM sync_meta WHERE key = 'cursor'", [], |row| row.get::<_, String>(0)).optional().ok().flatten().unwrap_or_default(),
    });
    Ok(build_envelope(conn, &data))
}

/// MCP 可共享子集：同一格式，只携带记忆正文（排除 secret/pii），不含收件箱、凭据密文与密钥材料。
pub fn export_share_backup(conn: &Connection) -> Result<Value, String> {
    let data = json!({
        "memories": dump_rows(
            conn,
            &format!("SELECT {MEMORIES_COLUMNS} FROM memories WHERE sensitivity NOT IN ('secret', 'pii') ORDER BY rowid"),
            &[],
        )?,
    });
    Ok(build_envelope(conn, &data))
}

fn build_envelope(conn: &Connection, data: &Value) -> Value {
    let mut counts = Map::new();
    if let Some(fields) = data.as_object() {
        for (key, value) in fields {
            let count = match key.as_str() {
                "syncCursor" => continue,
                _ => value.as_array().map(Vec::len).unwrap_or(0),
            };
            counts.insert(key.clone(), json!(count));
        }
    }
    let total: usize = counts.values().filter_map(|v| v.as_u64()).map(|v| v as usize).sum();
    json!({
        "kind": BACKUP_KIND,
        "formatVersion": FORMAT_VERSION,
        "appVersion": APP_VERSION,
        "exportedAt": now_iso(),
        "scope": if data.as_object().is_some_and(|fields| fields.len() == 1 && fields.contains_key("memories")) { "memory-share" } else { "full" },
        "counts": counts,
        "totalRows": total,
        "data": data,
    })
}

#[derive(Default)]
pub struct ImportReport {
    pub applied: Map<String, Value>,
    pub skipped: Map<String, Value>,
}

fn bump(applied: &mut Map<String, Value>, key: &str, count: usize) {
    *applied.entry(key.to_string()).or_insert(json!(0)) = json!(count);
}

fn bump_skipped(skipped: &mut Map<String, Value>, key: &str, count: usize) {
    if count > 0 {
        skipped.insert(key.to_string(), json!(count));
    }
}

/// 导入（合并恢复）：同一文件格式，按 id 合并覆盖，本地多出的行保留。
/// 记忆只在文件里的 rev 更新时覆盖；token_hash 归属另一把密钥的行跳过。
pub fn import_backup(conn: &mut Connection, envelope: &Value) -> Result<ImportReport, String> {
    let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != BACKUP_KIND {
        return Err("不是 OneLedger 备份文件（kind 不匹配）".into());
    }
    let format_version = envelope.get("formatVersion").and_then(Value::as_i64).unwrap_or(0);
    if format_version > FORMAT_VERSION {
        return Err(format!("备份格式版本 {format_version} 比当前支持的最高 {FORMAT_VERSION} 新，请先升级 OneLedger"));
    }
    let Some(data) = envelope.get("data").and_then(Value::as_object) else {
        return Err("备份缺少 data 字段".into());
    };
    let mut report = ImportReport::default();
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始导入".to_string())?;

    if let Some(rows) = section(data, "memories") {
        let mut applied = 0;
        let mut stale = 0;
        for row in rows {
            let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
            let rev = row.get("rev").and_then(Value::as_i64).unwrap_or(0);
            let current: Option<i64> = tx
                .query_row("SELECT rev FROM memories WHERE id = ?1", [id], |r| r.get(0))
                .optional()
                .map_err(|_| "无法读取现有记忆".to_string())?;
            if current.is_some_and(|existing| existing >= rev) {
                stale += 1;
                continue;
            }
            tx.execute("DELETE FROM memories WHERE id = ?1", params![id]).map_err(|_| "无法导入记忆".to_string())?;
            applied += insert_rows(&tx, "INSERT INTO memories ({columns}) VALUES ({values})", std::slice::from_ref(row), &[])?;
        }
        bump(&mut report.applied, "memories", applied);
        bump_skipped(&mut report.skipped, "memoriesStale", stale);
    }
    if let Some(rows) = section(data, "inbox") {
        bump(&mut report.applied, "inbox", insert_rows(&tx, &replace_sql("inbox"), rows, &[])?);
    }
    if let Some(rows) = section(data, "vaultItems") {
        bump(
            &mut report.applied,
            "vaultItems",
            insert_rows(&tx, &replace_sql("vault_items"), rows, &["protected_value"])?,
        );
    }
    if let Some(rows) = section(data, "apiKeys") {
        let mut applied = 0;
        let mut conflicts = 0;
        for row in rows {
            let (Some(id), Some(hash)) = (row.get("id").and_then(Value::as_str), row.get("token_hash").and_then(Value::as_str)) else {
                continue;
            };
            let owner: Option<String> = tx
                .query_row("SELECT id FROM api_keys WHERE token_hash = ?1", [hash], |r| r.get(0))
                .optional()
                .map_err(|_| "无法读取现有密钥".to_string())?;
            if owner.as_deref().is_some_and(|owner| owner != id) {
                conflicts += 1;
                continue;
            }
            applied += insert_rows(&tx, &replace_sql("api_keys"), std::slice::from_ref(row), &["protected_token"])?;
        }
        bump(&mut report.applied, "apiKeys", applied);
        bump_skipped(&mut report.skipped, "apiKeysHashConflict", conflicts);
    }
    if let Some(rows) = section(data, "agents") {
        bump(&mut report.applied, "agents", insert_rows(&tx, &replace_sql("agents"), rows, &[])?);
    }
    if let Some(rows) = section(data, "redactionEvents") {
        bump(&mut report.applied, "redactionEvents", insert_rows(&tx, &replace_sql("redaction_events"), rows, &[])?);
    }
    if let Some(rows) = section(data, "redactionArchive") {
        bump(&mut report.applied, "redactionArchive", insert_rows(&tx, &replace_sql("redaction_archive"), rows, &[])?);
    }
    if let Some(rows) = section(data, "collectFingerprints") {
        bump(
            &mut report.applied,
            "collectFingerprints",
            insert_rows(&tx, &replace_sql("collect_fingerprints"), rows, &[])?,
        );
    }
    if let Some(rows) = section(data, "distillDrafts") {
        bump(
            &mut report.applied,
            "distillDrafts",
            insert_rows(&tx, &replace_sql("distill_drafts"), rows, &[])?,
        );
    }
    if let Some(rows) = section(data, "trustedMcpSources") {
        bump(&mut report.applied, "trustedMcpSources", insert_rows(&tx, &ignore_sql("trusted_mcp_sources"), rows, &[])?);
    }
    if let Some(cursor) = data.get("syncCursor").and_then(Value::as_str).filter(|item| !item.is_empty()) {
        tx.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('cursor', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![cursor],
        )
        .map_err(|_| "无法导入同步游标".to_string())?;
        bump(&mut report.applied, "syncCursor", 1);
    }

    tx.commit().map_err(|_| "无法提交导入".to_string())?;
    Ok(report)
}

fn section<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a Vec<Value>> {
    data.get(key).and_then(Value::as_array).filter(|rows| !rows.is_empty())
}

fn replace_sql(table: &str) -> String {
    format!("INSERT OR REPLACE INTO {table} ({{columns}}) VALUES ({{values}})")
}

fn ignore_sql(table: &str) -> String {
    format!("INSERT OR IGNORE INTO {table} ({{columns}}) VALUES ({{values}})")
}

/// 导入前的内容摘要，供桌面确认弹窗展示。
pub fn summarize(envelope: &Value) -> Result<Map<String, Value>, String> {
    let data = envelope
        .get("data")
        .and_then(Value::as_object)
        .ok_or("备份缺少 data 字段")?;
    let mut counts = Map::new();
    for (key, value) in data {
        if key == "syncCursor" {
            continue;
        }
        if let Some(rows) = value.as_array().filter(|rows| !rows.is_empty()) {
            counts.insert(key.clone(), json!(rows.len()));
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_db;

    fn seed(conn: &Connection) {
        conn.execute_batch(
            r#"
            INSERT INTO memories (id, rev, title, body, scope_kind, scope_id, sensitivity, status, source, origin_node, content_hash, created_at, updated_at)
            VALUES ('mem_a', 1, '公开记忆', '正文A', 'project', 'Demo', 'public', 'active', 'ui', 'local', 'hash_a', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
            INSERT INTO memories (id, rev, title, body, scope_kind, scope_id, sensitivity, status, source, origin_node, content_hash, created_at, updated_at)
            VALUES ('mem_s', 1, '机密记忆', '机密正文', 'project', 'Demo', 'secret', 'active', 'ui', 'local', 'hash_s', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
            INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids)
            VALUES ('in_a', '收件', '内容', 'test', 'project', 'Demo', 'internal', 0, '2026-09-01T00:00:00.000Z', 'proposed', '');
            INSERT INTO api_keys (id, name, token_hash, token_prefix, protected_token, scopes, tools, created_at)
            VALUES ('key_a', 'agent', 'hash_one', 'ol_a', X'0102', 'global', 'memory.search', 'now');
            INSERT INTO api_keys (id, name, token_hash, token_prefix, protected_token, scopes, tools, created_at)
            VALUES ('key_b', 'other', 'hash_two', 'ol_b', NULL, 'global', 'memory.search', 'now');
            INSERT INTO vault_items (id, label, scope_kind, scope_id, protected_value, created_at, updated_at)
            VALUES ('vault_a', '凭据', 'global', '', X'030405', 'now', 'now');
            INSERT INTO agents (id, name, kind, builtin, enabled, root_path, last_scanned_files, last_ingested, last_queued, last_redacted, last_error, created_at)
            VALUES ('agent_a', 'Demo', 'custom', 0, 1, 'E:/Demo', 0, 0, 0, 0, '', 'now');
            INSERT INTO trusted_mcp_sources (key_id, source, created_at) VALUES ('key_a', '127.0.0.1', 'now');
            INSERT INTO redaction_archive (day, hit_type, count) VALUES ('2026-09-01', 'token', 2);
            "#,
        )
        .expect("seed");
    }

    #[test]
    fn full_backup_roundtrip_restores_every_table() {
        let conn = open_db(":memory:").expect("db");
        seed(&conn);
        let backup = export_backup(&conn).expect("export");
        assert_eq!(backup["kind"], BACKUP_KIND);
        assert_eq!(backup["scope"], "full");
        assert_eq!(backup["counts"]["memories"], json!(2));
        assert_eq!(backup["counts"]["vaultItems"], json!(1));

        let mut fresh = open_db(":memory:").expect("db2");
        let report = import_backup(&mut fresh, &backup).expect("import");
        assert_eq!(report.applied.get("memories"), Some(&json!(2)));
        assert_eq!(report.applied.get("inbox"), Some(&json!(1)));
        assert_eq!(report.applied.get("vaultItems"), Some(&json!(1)));
        assert_eq!(report.applied.get("apiKeys"), Some(&json!(2)));
        assert_eq!(report.applied.get("agents"), Some(&json!(1)));
        assert_eq!(report.applied.get("trustedMcpSources"), Some(&json!(1)));
        assert_eq!(report.applied.get("redactionArchive"), Some(&json!(1)));
        let blob: Vec<u8> = fresh.query_row("SELECT protected_value FROM vault_items WHERE id = 'vault_a'", [], |r| r.get(0)).expect("blob");
        assert_eq!(blob, vec![3, 4, 5]);
        let key_blob: Vec<u8> = fresh.query_row("SELECT protected_token FROM api_keys WHERE id = 'key_a'", [], |r| r.get(0)).expect("key blob");
        assert_eq!(key_blob, vec![1, 2]);
        let fts: i64 = fresh.query_row("SELECT COUNT(*) FROM memories_fts WHERE memories_fts MATCH '正文A'", [], |r| r.get(0)).expect("fts");
        assert_eq!(fts, 1);
    }

    #[test]
    fn import_is_merge_stale_revs_are_kept_local() {
        let conn = open_db(":memory:").expect("db");
        seed(&conn);
        let backup = export_backup(&conn).expect("export");
        let mut target = open_db(":memory:").expect("db2");
        import_backup(&mut target, &backup).expect("import first");
        target
            .execute(
                "UPDATE memories SET rev = 5, body = '本地更新' WHERE id = 'mem_a'",
                [],
            )
            .expect("local edit");
        let report = import_backup(&mut target, &backup).expect("import again");
        assert_eq!(report.skipped.get("memoriesStale"), Some(&json!(2)));
        let body: String = target.query_row("SELECT body FROM memories WHERE id = 'mem_a'", [], |r| r.get(0)).expect("body");
        assert_eq!(body, "本地更新");
    }

    #[test]
    fn api_key_rows_with_foreign_hash_are_skipped() {
        let mut conn = open_db(":memory:").expect("db");
        seed(&conn);
        let backup = export_backup(&conn).expect("export");
        let hash_one: String = backup["data"]["apiKeys"].as_array().unwrap()[0]["token_hash"].as_str().expect("hash").to_string();
        let mut target = open_db(":memory:").expect("db2");
        target
            .execute(
                "INSERT INTO api_keys (id, name, token_hash, token_prefix, scopes, tools, created_at) VALUES ('key_other', '占用者', ?1, 'ol_x', 'global', 'memory.search', 'now')",
                [&hash_one],
            )
            .expect("conflicting key");
        let report = import_backup(&mut target, &backup).expect("import");
        assert_eq!(report.applied.get("apiKeys"), Some(&json!(1)));
        assert_eq!(report.skipped.get("apiKeysHashConflict"), Some(&json!(1)));
    }

    #[test]
    fn share_backup_excludes_secret_rows_and_sensitive_tables() {
        let conn = open_db(":memory:").expect("db");
        seed(&conn);
        let share = export_share_backup(&conn).expect("share");
        assert_eq!(share["scope"], "memory-share");
        assert_eq!(share["counts"]["memories"], json!(1));
        let rows = share["data"]["memories"].as_array().expect("rows");
        assert_eq!(rows[0]["id"], json!("mem_a"));
        assert!(share["data"].get("vaultItems").is_none());
        assert!(share["data"].get("apiKeys").is_none());
        assert!(share["data"].get("inbox").is_none());
        let report = import_backup(&mut open_db(":memory:").expect("db2"), &share).expect("import share");
        assert_eq!(report.applied.get("memories"), Some(&json!(1)));
    }

    #[test]
    fn rejects_foreign_kind_and_newer_formats() {
        let mut conn = open_db(":memory:").expect("db");
        let mut envelope = json!({ "kind": "other", "formatVersion": 1, "data": {} });
        assert!(import_backup(&mut conn, &envelope).is_err());
        envelope = json!({ "kind": BACKUP_KIND, "formatVersion": FORMAT_VERSION + 1, "data": {} });
        assert!(import_backup(&mut conn, &envelope).is_err());
        assert!(summarize(&json!({ "kind": BACKUP_KIND, "data": { "memories": [ {"id": "x"} ] } })).is_ok());
    }
}
