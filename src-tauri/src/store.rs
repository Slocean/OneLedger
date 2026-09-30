use crate::models::{AgentRecord, ApiKeyRecord, InboxRecord, MemoryRecord, TrustedMcpSourceRecord};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};

pub fn insert_inbox(conn: &Connection, record: InboxRecord) -> rusqlite::Result<InboxRecord> {
    conn.execute(
        "INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids, source_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            record.id,
            record.title,
            record.body,
            record.source,
            record.scope_kind,
            record.scope_id,
            record.sensitivity,
            record.redacted,
            record.created_at,
            record.queue_status,
            record.conflict_ids.join(","),
            record.source_key,
        ],
    )?;
    Ok(record)
}

pub fn get_inbox(conn: &Connection, id: &str) -> rusqlite::Result<Option<InboxRecord>> {
    conn.query_row("SELECT * FROM inbox WHERE id = ?1", [id], map_inbox)
        .optional()
}

pub fn find_collected_inbox(conn: &Connection, source: &str, scope_kind: &str, scope_id: &str, body: &str, source_key: &str) -> rusqlite::Result<Option<InboxRecord>> {
    // 材料级查重必须限定作用域：不同仓库同文不是同一材料（P0-04）。
    // B-05：查重身份再收紧到同一来源键——同仓库两个不同文件（不同 source_key）同文时
    // 各自成一条，不能再用其他文件的相同正文当唯一依据。
    // 人工创建与 v12 之前的历史行 source_key 为空串，只在键同为空串时互相匹配（保守，不擅自合并）。
    conn.query_row(
        "SELECT * FROM inbox WHERE source = ?1 AND scope_kind = ?2 AND scope_id = ?3 AND substr(body, 1, 128) = substr(?4, 1, 128) AND body = ?4 AND source_key = ?5 ORDER BY id LIMIT 1",
        params![source, scope_kind, scope_id, body, source_key],
        map_inbox,
    ).optional()
}

#[cfg(test)]
pub fn list_inbox(conn: &Connection) -> rusqlite::Result<Vec<InboxRecord>> {
    list_inbox_status(conn, "proposed", 20000, 0)
}

#[cfg(test)]
pub fn list_inbox_status(conn: &Connection, status: &str, limit: i64, offset: i64) -> rusqlite::Result<Vec<InboxRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM inbox WHERE queue_status = ?1
         ORDER BY CASE WHEN lower(source) LIKE '%workbuddy%' THEN 0 ELSE 1 END, created_at DESC
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![status, limit, offset], map_inbox)?;
    rows.collect()
}

pub fn reject_inbox(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE inbox SET queue_status = 'rejected' WHERE id = ?1", [id])?;
    Ok(())
}

pub fn delete_inbox(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM inbox WHERE id = ?1", [id])?;
    Ok(())
}

pub fn find_active_by_hash(conn: &Connection, hash: &str, scope_kind: &str, scope_id: &str) -> rusqlite::Result<Option<MemoryRecord>> {
    conn.query_row(
        "SELECT * FROM memories WHERE content_hash = ?1 AND status = 'active' AND scope_kind = ?2 AND scope_id = ?3 LIMIT 1",
        params![hash, scope_kind, scope_id],
        map_memory,
    )
    .optional()
}

pub fn list_active_by_scope(
    conn: &Connection,
    scope_kind: &str,
    scope_id: &str,
) -> rusqlite::Result<Vec<MemoryRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM memories WHERE status = 'active' AND scope_kind = ?1 AND scope_id = ?2 ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map(params![scope_kind, scope_id], map_memory)?;
    rows.collect()
}

pub fn upsert_memory(conn: &Connection, record: &MemoryRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO memories (
           id, rev, title, body, scope_kind, scope_id, sensitivity, status, source,
           origin_node, content_hash, created_at, updated_at, forgotten_at, superseded_by
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           rev = excluded.rev, title = excluded.title, body = excluded.body,
           scope_kind = excluded.scope_kind, scope_id = excluded.scope_id,
           sensitivity = excluded.sensitivity, status = excluded.status, source = excluded.source,
           origin_node = excluded.origin_node, content_hash = excluded.content_hash,
           updated_at = excluded.updated_at, forgotten_at = excluded.forgotten_at,
           superseded_by = excluded.superseded_by",
        params![
            record.id,
            record.rev,
            record.title,
            record.body,
            record.scope_kind,
            record.scope_id,
            record.sensitivity,
            record.status,
            record.source,
            record.origin_node,
            record.content_hash,
            record.created_at,
            record.updated_at,
            record.forgotten_at,
            record.superseded_by
        ],
    )?;
    Ok(())
}

pub fn get_memory(conn: &Connection, id: &str) -> rusqlite::Result<Option<MemoryRecord>> {
    conn.query_row("SELECT * FROM memories WHERE id = ?1", [id], map_memory)
        .optional()
}

pub fn list_memories(
    conn: &Connection,
    limit: i64,
    scope_kind: Option<&str>,
    scope_id: Option<&str>,
) -> rusqlite::Result<Vec<MemoryRecord>> {
    let kind = scope_kind.unwrap_or("");
    let id = scope_id.unwrap_or("");
    let mut stmt = conn.prepare(
        "SELECT * FROM memories
         WHERE status != 'forgotten'
           AND (?1 = '' OR scope_kind = ?1)
           AND (?2 = '' OR scope_id = ?2)
         ORDER BY updated_at DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![kind, id, limit], map_memory)?;
    rows.collect()
}

pub fn list_active(conn: &Connection) -> rusqlite::Result<Vec<MemoryRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 200")?;
    let rows = stmt.query_map([], map_memory)?;
    rows.collect()
}

pub fn search_memories(
    conn: &Connection,
    query: &str,
    limit: i64,
    scope_kind: Option<&str>,
    scope_id: Option<&str>,
) -> rusqlite::Result<Vec<MemoryRecord>> {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    let kind = scope_kind.unwrap_or("");
    let id = scope_id.unwrap_or("");
    if !terms.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT memories.* FROM memories_fts JOIN memories ON memories.rowid = memories_fts.rowid
             WHERE memories_fts MATCH ?1 AND memories.status = 'active' AND memories.sensitivity != 'secret'
               AND (?2 = '' OR memories.scope_kind = ?2)
               AND (?3 = '' OR memories.scope_id = ?3)
             ORDER BY bm25(memories_fts), memories.updated_at DESC LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![terms.join(" AND "), kind, id, limit], map_memory)?;
        return rows.collect();
    }
    let needle = format!("%{}%", query.replace('%', ""));
    let mut stmt = conn.prepare(
        "SELECT * FROM memories
         WHERE status = 'active' AND sensitivity != 'secret'
           AND (?1 = '' OR scope_kind = ?1)
           AND (?2 = '' OR scope_id = ?2)
           AND (title LIKE ?3 OR body LIKE ?3)
         ORDER BY updated_at DESC LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![kind, id, needle, limit], map_memory)?;
    rows.collect()
}

pub fn changed_since(conn: &Connection, since: &str) -> rusqlite::Result<Vec<MemoryRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM memories WHERE updated_at > ?1 ORDER BY updated_at ASC")?;
    let rows = stmt.query_map([since], map_memory)?;
    rows.collect()
}

pub fn counts(conn: &Connection) -> rusqlite::Result<serde_json::Value> {
    let active: i64 = conn.query_row("SELECT COUNT(*) FROM memories WHERE status = 'active'", [], |row| row.get(0))?;
    let forgotten: i64 =
        conn.query_row("SELECT COUNT(*) FROM memories WHERE status = 'forgotten'", [], |row| row.get(0))?;
    let inbox: i64 =
        conn.query_row("SELECT COUNT(*) FROM inbox WHERE queue_status = 'proposed'", [], |row| row.get(0))?;
    Ok(serde_json::json!({ "active": active, "inbox": inbox, "forgotten": forgotten }))
}

pub fn prune_history(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(90))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare(
        "SELECT substr(at, 1, 10), hit_type, COUNT(*) FROM redaction_events WHERE at < ?1 GROUP BY substr(at, 1, 10), hit_type",
    )?;
    let archive: Vec<(String, String, i64)> = stmt
        .query_map([&cutoff], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    for (day, kind, count) in archive {
        tx.execute(
            "INSERT INTO redaction_archive(day, hit_type, count) VALUES (?1, ?2, ?3)
             ON CONFLICT(day, hit_type) DO UPDATE SET count = count + excluded.count",
            params![day, kind, count],
        )?;
    }
    let events = tx.execute("DELETE FROM redaction_events WHERE at < ?1", [&cutoff])?;
    let rejected = tx.execute("DELETE FROM inbox WHERE queue_status = 'rejected' AND created_at < ?1", [&cutoff])?;
    if events > 0 || rejected > 0 {
        audit(&tx, "system", "history.prune", &format!("redaction_events={events},rejected={rejected}"))?;
    }
    tx.commit()?;
    Ok((events, rejected))
}

pub fn add_redaction(conn: &Connection, source: &str, hit_type: &str, inbox_id: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO redaction_events (id, at, source, hit_type, inbox_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_id("rd"), now_iso(), source, hit_type, inbox_id],
    )?;
    Ok(())
}

pub fn list_redactions(conn: &Connection) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT id, at, source, hit_type FROM redaction_events ORDER BY at DESC LIMIT 50")?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "at": row.get::<_, String>(1)?,
            "source": row.get::<_, String>(2)?,
            "hit_type": row.get::<_, String>(3)?,
        }))
    })?;
    rows.collect()
}

pub fn audit(conn: &Connection, actor: &str, action: &str, detail: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO audit_log (id, at, actor, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_id("au"), now_iso(), actor, action, detail],
    )?;
    Ok(())
}

pub fn list_audit(conn: &Connection) -> rusqlite::Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT id, at, actor, action, detail FROM audit_log ORDER BY at DESC LIMIT 50")?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "id": row.get::<_, String>(0)?,
            "at": row.get::<_, String>(1)?,
            "actor": row.get::<_, String>(2)?,
            "action": row.get::<_, String>(3)?,
            "detail": row.get::<_, String>(4)?,
        }))
    })?;
    rows.collect()
}

pub fn insert_key(conn: &Connection, record: &ApiKeyRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO api_keys (id, name, token_hash, token_prefix, protected_token, scopes, tools, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            record.id,
            record.name,
            record.token_hash,
            record.token_prefix,
            record.protected_token,
            record.scopes,
            record.tools,
            record.created_at,
            record.last_used_at
        ],
    )?;
    Ok(())
}

pub fn find_key_by_hash(conn: &Connection, token_hash: &str) -> rusqlite::Result<Option<ApiKeyRecord>> {
    conn.query_row("SELECT * FROM api_keys WHERE token_hash = ?1", [token_hash], map_key)
        .optional()
}

pub fn find_key_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<ApiKeyRecord>> {
    conn.query_row("SELECT * FROM api_keys WHERE id = ?1", [id], map_key).optional()
}

pub fn protect_existing_key(conn: &Connection, id: &str, protected: &[u8]) -> rusqlite::Result<bool> {
    Ok(conn.execute("UPDATE api_keys SET protected_token = ?1 WHERE id = ?2 AND protected_token IS NULL", params![protected, id])? == 1)
}

pub fn list_keys(conn: &Connection) -> rusqlite::Result<Vec<ApiKeyRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM api_keys ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], map_key)?;
    rows.collect()
}

pub fn touch_key(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2", params![now_iso(), id])?;
    Ok(())
}

pub fn mcp_source_trusted(conn: &Connection, key_id: &str, source: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM trusted_mcp_sources WHERE key_id = ?1 AND source = ?2",
        [key_id, source],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn trust_mcp_source(conn: &Connection, key_id: &str, source: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO trusted_mcp_sources (key_id, source, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key_id, source) DO NOTHING",
        params![key_id, source, now_iso()],
    )?;
    Ok(())
}

pub fn list_trusted_mcp_sources(conn: &Connection) -> rusqlite::Result<Vec<TrustedMcpSourceRecord>> {
    let mut stmt = conn.prepare(
        "SELECT t.key_id, COALESCE(k.name, ''), t.source, t.created_at
         FROM trusted_mcp_sources t LEFT JOIN api_keys k ON k.id = t.key_id
         ORDER BY t.created_at DESC, t.key_id ASC, t.source ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TrustedMcpSourceRecord {
            key_id: row.get(0)?,
            key_name: row.get(1)?,
            source: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn delete_trusted_mcp_source(conn: &Connection, key_id: &str, source: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM trusted_mcp_sources WHERE key_id = ?1 AND source = ?2", params![key_id, source])? == 1)
}

pub fn get_sync_cursor(conn: &Connection) -> rusqlite::Result<String> {
    Ok(conn
        .query_row("SELECT value FROM sync_meta WHERE key = 'cursor'", [], |row| row.get(0))
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into()))
}

pub fn set_sync_cursor(conn: &Connection, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('cursor', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [value],
    )?;
    Ok(())
}

pub fn get_agent(conn: &Connection, id: &str) -> rusqlite::Result<Option<AgentRecord>> {
    conn.query_row("SELECT * FROM agents WHERE id = ?1", [id], map_agent)
        .optional()
}

pub fn list_agents(conn: &Connection) -> rusqlite::Result<Vec<AgentRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM agents ORDER BY builtin DESC, name ASC")?;
    let rows = stmt.query_map([], map_agent)?;
    rows.collect()
}

pub fn upsert_agent(conn: &Connection, record: &AgentRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO agents (
           id, name, kind, builtin, enabled, root_path, last_scanned_at, last_scanned_files,
           last_ingested, last_queued, last_redacted, last_error, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, builtin = excluded.builtin,
           enabled = excluded.enabled, root_path = excluded.root_path,
           last_scanned_at = excluded.last_scanned_at, last_scanned_files = excluded.last_scanned_files,
           last_ingested = excluded.last_ingested, last_queued = excluded.last_queued,
           last_redacted = excluded.last_redacted, last_error = excluded.last_error",
        params![
            record.id,
            record.name,
            record.kind,
            record.builtin as i64,
            record.enabled as i64,
            record.root_path,
            record.last_scanned_at,
            record.last_scanned_files,
            record.last_ingested,
            record.last_queued,
            record.last_redacted,
            record.last_error,
            record.created_at
        ],
    )?;
    Ok(())
}

pub fn delete_agent(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agents WHERE id = ?1 AND builtin = 0", [id])?;
    Ok(())
}

/// 按作用域聚合待蒸馏材料（旧全量接口，仅测试与迁移兼容保留）。
#[cfg(test)]
pub fn inbox_scope_summary(
    conn: &Connection,
) -> rusqlite::Result<Vec<(String, String, i64, i64, Option<String>, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT scope_kind, scope_id,
                COUNT(*) AS pending,
                SUM(CASE WHEN lower(source) LIKE '%workbuddy%' THEN 1 ELSE 0 END) AS high_signal,
                MIN(created_at) AS oldest_at,
                MAX(created_at) AS newest_at
         FROM inbox WHERE queue_status = 'proposed'
         GROUP BY scope_kind, scope_id
         ORDER BY high_signal DESC, newest_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    })?;
    rows.collect()
}

/// project 作用域里像路径而不是仓库名的 scopeId。这只是待审标记，
/// 不能凭字符串推断真实仓库名，归并目标必须由管理员人工确认。
pub fn scope_id_looks_like_path(scope_id: &str) -> bool {
    scope_id.contains('/')
        || scope_id.contains('\\')
        || scope_id.contains(':')
        || scope_id == "."
        || scope_id == ".."
}

pub struct InboxScopeRow {
    pub scope_kind: String,
    pub scope_id: String,
    pub pending: i64,
    pub workbuddy: i64,
    pub oldest_at: Option<String>,
    #[allow(dead_code)]
    pub newest_at: Option<String>,
}

/// 服务端分页的作用域聚合列表：SQL 内筛选与计数，不把全部作用域传给前端。
/// query 按子串匹配 scope_id；only_abnormal 只保留归属待修正的 project 作用域
/// （scopeId 含路径分隔符、盘符迹象或 . / .. 片段）。
pub fn inbox_scope_page(
    conn: &Connection,
    query: &str,
    only_abnormal: bool,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<(Vec<InboxScopeRow>, i64)> {
    let having = if only_abnormal {
        "HAVING scope_kind = 'project'
            AND (scope_id LIKE '%/%' OR scope_id LIKE '%\\%'
                 OR scope_id LIKE '%:%' OR scope_id = '.' OR scope_id = '..')"
    } else {
        "HAVING scope_kind = scope_kind"
    };
    let base = format!(
        "FROM inbox WHERE queue_status = 'proposed'
           AND (?1 = '' OR scope_id LIKE '%' || ?1 || '%')
         GROUP BY scope_kind, scope_id
         {having}"
    );
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM (SELECT scope_kind {base})"),
        params![query],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT scope_kind, scope_id,
                COUNT(*) AS pending,
                SUM(CASE WHEN lower(source) LIKE '%workbuddy%' THEN 1 ELSE 0 END) AS workbuddy,
                MIN(created_at) AS oldest_at,
                MAX(created_at) AS newest_at
         {base}
         ORDER BY newest_at DESC, scope_id ASC
         LIMIT ?2 OFFSET ?3"
    ))?;
    let rows = stmt
        .query_map(params![query, limit, offset], |row| {
            Ok(InboxScopeRow {
                scope_kind: row.get(0)?,
                scope_id: row.get(1)?,
                pending: row.get(2)?,
                workbuddy: row.get(3)?,
                oldest_at: row.get(4)?,
                newest_at: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((rows, total))
}

/// 服务端分页+筛选的材料明细。稳定次序为 created_at DESC, id DESC；
/// scope/source 过滤在 SQL 内完成，任何一次调用都不返回全量正文。
pub fn inbox_page(
    conn: &Connection,
    status: &str,
    scope_kind: Option<&str>,
    scope_id: Option<&str>,
    source: Option<&str>,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<(Vec<InboxRecord>, i64)> {
    let kind = scope_kind.filter(|item| !item.is_empty()).unwrap_or("");
    let id = scope_id.filter(|item| !item.is_empty()).unwrap_or("");
    let src = source.filter(|item| !item.is_empty()).unwrap_or("");
    let where_sql =
        "WHERE queue_status = ?1 AND (?2 = '' OR scope_kind = ?2) AND (?3 = '' OR scope_id = ?3) AND (?4 = '' OR source = ?4)";
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM inbox {where_sql}"), params![status, kind, id, src], |row| row.get(0))?;
    let mut stmt = conn.prepare(&format!(
        "SELECT * FROM inbox {where_sql} ORDER BY created_at DESC, id DESC LIMIT ?5 OFFSET ?6"
    ))?;
    let rows = stmt
        .query_map(params![status, kind, id, src, limit, offset], map_inbox)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((rows, total))
}

/// 按精确 ID 集合取材料（供草稿审核展示草稿来源元数据）；顺序按传入次序。
pub fn inbox_by_ids(conn: &Connection, ids: &[String]) -> rusqlite::Result<Vec<InboxRecord>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_json = serde_json::to_string(ids).unwrap_or_else(|_| "[]".into());
    let mut by_id = std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT * FROM inbox WHERE id IN (SELECT value FROM json_each(?1))",
        )?;
        let rows = stmt
            .query_map([&ids_json], map_inbox)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in rows {
            by_id.insert(row.id.clone(), row);
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

pub struct FingerprintRow {
    pub id: String,
    pub content_hash: String,
    #[allow(dead_code)]
    pub last_status: String,
}

/// 指纹触碰的单调序号：同毫秒时间戳并列时（C-02）按最近触碰排序，取序号最大者为最新。
fn next_fingerprint_seq(conn: &Connection) -> rusqlite::Result<i64> {
    let current: i64 = conn
        .query_row("SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'fp_seq'", [], |row| row.get(0))
        .optional()?
        .unwrap_or(0);
    let next = current + 1;
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('fp_seq', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![next.to_string()],
    )?;
    Ok(next)
}

pub fn latest_fingerprint(
    conn: &Connection,
    collector: &str,
    source_key: &str,
    scope_kind: &str,
    scope_id: &str,
    rules_version: i64,
) -> rusqlite::Result<Option<FingerprintRow>> {
    conn.query_row(
        "SELECT id, content_hash, last_status FROM collect_fingerprints
         WHERE collector = ?1 AND source_key = ?2 AND scope_kind = ?3 AND scope_id = ?4 AND rules_version = ?5
         ORDER BY touched_seq DESC, rowid DESC LIMIT 1",
        params![collector, source_key, scope_kind, scope_id, rules_version],
        |row| Ok(FingerprintRow { id: row.get(0)?, content_hash: row.get(1)?, last_status: row.get(2)? }),
    )
    .optional()
}

pub fn touch_fingerprint(conn: &Connection, id: &str, last_status: &str) -> rusqlite::Result<()> {
    let seq = next_fingerprint_seq(conn)?;
    conn.execute(
        "UPDATE collect_fingerprints SET last_seen_at = ?1, last_status = ?2, touched_seq = ?3 WHERE id = ?4",
        params![now_iso(), last_status, seq, id],
    )?;
    Ok(())
}

/// 跨作用域查最近指纹：只用于可证明跨作用域唯一的来源键（规范化后的绝对路径）。
/// 指纹保留其原作用域作为历史归属，这里只读不改。
pub fn latest_fingerprint_global(
    conn: &Connection,
    collector: &str,
    source_key: &str,
    rules_version: i64,
) -> rusqlite::Result<Option<FingerprintRow>> {
    conn.query_row(
        "SELECT id, content_hash, last_status FROM collect_fingerprints
         WHERE collector = ?1 AND source_key = ?2 AND rules_version = ?3
         ORDER BY touched_seq DESC, rowid DESC LIMIT 1",
        params![collector, source_key, rules_version],
        |row| Ok(FingerprintRow { id: row.get(0)?, content_hash: row.get(1)?, last_status: row.get(2)? }),
    )
    .optional()
}

pub fn insert_fingerprint(
    conn: &Connection,
    collector: &str,
    source_key: &str,
    scope_kind: &str,
    scope_id: &str,
    content_hash: &str,
    rules_version: i64,
    last_status: &str,
) -> rusqlite::Result<()> {
    let now = now_iso();
    let seq = next_fingerprint_seq(conn)?;
    conn.execute(
        "INSERT INTO collect_fingerprints
           (id, collector, source_key, scope_kind, scope_id, content_hash, rules_version, last_status, first_seen_at, last_seen_at, touched_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (collector, source_key, scope_kind, scope_id, content_hash, rules_version)
         DO UPDATE SET last_seen_at = excluded.last_seen_at, last_status = excluded.last_status, touched_seq = excluded.touched_seq",
        params![new_id("fp"), collector, source_key, scope_kind, scope_id, content_hash, rules_version, last_status, now, now, seq],
    )?;
    Ok(())
}

pub struct ScopeMergeOperation {
    pub id: String,
    pub from_scope_kind: String,
    pub from_scope_id: String,
    pub to_scope_kind: String,
    pub to_scope_id: String,
    /// v10 遗留文本字段；新操作不再写入（空串），批次精确 ID 在 scope_merge_operation_items。
    pub moved_ids: Vec<String>,
    pub moved_count: i64,
    pub source_breakdown: serde_json::Value,
    pub status: String,
    pub created_at: String,
    pub reverted_at: Option<String>,
}

impl ScopeMergeOperation {
    /// 本批精确 ID：优先读 item 表；旧记录的 moved_ids 文本仅作只读兼容回退。
    pub fn batch_ids(&self) -> Vec<String> {
        self.moved_ids.clone()
    }
}

pub fn insert_merge_operation(conn: &Connection, op: &ScopeMergeOperation) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO scope_merge_operations
           (id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_ids, moved_count, source_breakdown, status, created_at, reverted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            op.id,
            op.from_scope_kind,
            op.from_scope_id,
            op.to_scope_kind,
            op.to_scope_id,
            // 新操作不再把 ID 列表塞进单个 TEXT；批次明细在 scope_merge_operation_items。
            String::new(),
            op.moved_count,
            op.source_breakdown.to_string(),
            op.status,
            op.created_at,
            op.reverted_at
        ],
    )?;
    insert_merge_operation_items(conn, &op.id, &op.moved_ids)
}

pub fn insert_merge_operation_items(conn: &Connection, operation_id: &str, inbox_ids: &[String]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO scope_merge_operation_items (operation_id, inbox_id) VALUES (?1, ?2)",
    )?;
    for inbox_id in inbox_ids {
        stmt.execute(params![operation_id, inbox_id])?;
    }
    Ok(())
}

/// 本批精确 ID（按入库次序）。
pub fn get_merge_operation_batch(conn: &Connection, operation_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = ?1",
    )?;
    let rows = stmt
        .query_map([operation_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_merge_operation(conn: &Connection, id: &str) -> rusqlite::Result<Option<ScopeMergeOperation>> {
    conn.query_row("SELECT * FROM scope_merge_operations WHERE id = ?1", [id], map_merge_operation).optional()
}

/// 撤销/详情用的完整操作（含 item 表批次 ID）。
pub fn load_merge_operation(conn: &Connection, id: &str) -> rusqlite::Result<Option<ScopeMergeOperation>> {
    let Some(mut op) = get_merge_operation(conn, id)? else { return Ok(None) };
    let items = get_merge_operation_batch(conn, id)?;
    if !items.is_empty() {
        op.moved_ids = items;
    }
    Ok(Some(op))
}

pub struct ScopeMergeOperationSummary {
    pub id: String,
    pub from_scope_kind: String,
    pub from_scope_id: String,
    pub to_scope_kind: String,
    pub to_scope_id: String,
    pub moved_count: i64,
    pub source_breakdown: serde_json::Value,
    pub status: String,
    pub created_at: String,
    pub reverted_at: Option<String>,
}

/// 列表只读概要字段：单次分页 SQL，不读 moved_ids 大字段，避免反序列化巨量 ID（M-03）。
pub fn list_merge_operation_summaries(
    conn: &Connection,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<(Vec<ScopeMergeOperationSummary>, i64)> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM scope_merge_operations", [], |row| row.get(0))?;
    let mut stmt = conn.prepare(
        "SELECT id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_count, source_breakdown, status, created_at, reverted_at
         FROM scope_merge_operations ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |row| {
            let breakdown: String = row.get("source_breakdown")?;
            Ok(ScopeMergeOperationSummary {
                id: row.get("id")?,
                from_scope_kind: row.get("from_scope_kind")?,
                from_scope_id: row.get("from_scope_id")?,
                to_scope_kind: row.get("to_scope_kind")?,
                to_scope_id: row.get("to_scope_id")?,
                moved_count: row.get("moved_count")?,
                source_breakdown: serde_json::from_str(&breakdown).unwrap_or(serde_json::json!({})),
                status: row.get("status")?,
                created_at: row.get("created_at")?,
                reverted_at: row.get("reverted_at")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((rows, total))
}

fn map_merge_operation(row: &rusqlite::Row) -> rusqlite::Result<ScopeMergeOperation> {
    let moved: String = row.get("moved_ids")?;
    let breakdown: String = row.get("source_breakdown")?;
    Ok(ScopeMergeOperation {
        id: row.get("id")?,
        from_scope_kind: row.get("from_scope_kind")?,
        from_scope_id: row.get("from_scope_id")?,
        to_scope_kind: row.get("to_scope_kind")?,
        to_scope_id: row.get("to_scope_id")?,
        moved_ids: moved.split('\u{1f}').filter(|item| !item.is_empty()).map(str::to_string).collect(),
        moved_count: row.get("moved_count")?,
        source_breakdown: serde_json::from_str(&breakdown).unwrap_or(serde_json::json!({})),
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        reverted_at: row.get("reverted_at")?,
    })
}

fn map_memory(row: &rusqlite::Row) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: row.get("id")?,
        rev: row.get("rev")?,
        title: row.get("title")?,
        body: row.get("body")?,
        scope_kind: row.get("scope_kind")?,
        scope_id: row.get("scope_id")?,
        sensitivity: row.get("sensitivity")?,
        status: row.get("status")?,
        source: row.get("source")?,
        origin_node: row.get("origin_node")?,
        content_hash: row.get("content_hash")?,
        superseded_by: row.get("superseded_by")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        forgotten_at: row.get("forgotten_at")?,
    })
}

fn map_inbox(row: &rusqlite::Row) -> rusqlite::Result<InboxRecord> {
    let conflict: String = row.get("conflict_ids").unwrap_or_default();
    Ok(InboxRecord {
        id: row.get("id")?,
        title: row.get("title")?,
        body: row.get("body")?,
        source: row.get("source")?,
        scope_kind: row.get("scope_kind")?,
        scope_id: row.get("scope_id")?,
        sensitivity: row.get("sensitivity")?,
        redacted: row.get("redacted")?,
        queue_status: row.get("queue_status").unwrap_or_else(|_| "proposed".into()),
        conflict_ids: conflict.split(',').filter(|item| !item.is_empty()).map(str::to_string).collect(),
        created_at: row.get("created_at")?,
        source_key: row.get("source_key").unwrap_or_default(),
    })
}

fn map_key(row: &rusqlite::Row) -> rusqlite::Result<ApiKeyRecord> {
    Ok(ApiKeyRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        token_hash: row.get("token_hash")?,
        token_prefix: row.get("token_prefix")?,
        protected_token: row.get("protected_token")?,
        scopes: row.get("scopes")?,
        tools: row.get("tools")?,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
    })
}

fn map_agent(row: &rusqlite::Row) -> rusqlite::Result<AgentRecord> {
    let builtin: i64 = row.get("builtin")?;
    let enabled: i64 = row.get("enabled")?;
    Ok(AgentRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        builtin: builtin == 1,
        enabled: enabled == 1,
        root_path: row.get("root_path")?,
        last_scanned_at: row.get("last_scanned_at")?,
        last_scanned_files: row.get("last_scanned_files")?,
        last_ingested: row.get("last_ingested")?,
        last_queued: row.get("last_queued")?,
        last_redacted: row.get("last_redacted")?,
        last_error: row.get("last_error").unwrap_or_default(),
        created_at: row.get("created_at")?,
    })
}

#[cfg(test)]
mod retention_tests {
    use super::prune_history;
    use crate::db;

    #[test]
    fn archives_old_redactions_before_removing_rejected_rows() {
        let conn = db::open_db(":memory:").expect("db");
        conn.execute("INSERT INTO inbox(id,title,body,source,scope_kind,scope_id,sensitivity,redacted,created_at,queue_status,conflict_ids) VALUES ('old','[REDACTED]','[REDACTED]','test','personal','','secret',1,'2020-01-01T00:00:00.000Z','rejected','')", []).expect("inbox");
        conn.execute("INSERT INTO redaction_events(id,at,source,hit_type,inbox_id) VALUES ('event','2020-01-01T00:00:00.000Z','test','high_entropy','old')", []).expect("event");
        assert_eq!(prune_history(&conn).expect("prune"), (1, 1));
        let archived: i64 = conn.query_row("SELECT count FROM redaction_archive WHERE day = '2020-01-01' AND hit_type = 'high_entropy'", [], |row| row.get(0)).expect("archive");
        assert_eq!(archived, 1);
    }
}
