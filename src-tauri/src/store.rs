use crate::models::{AgentRecord, ApiKeyRecord, InboxRecord, MemoryRecord};
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};

pub fn insert_inbox(conn: &Connection, record: InboxRecord) -> rusqlite::Result<InboxRecord> {
    conn.execute(
        "INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
            record.conflict_ids.join(",")
        ],
    )?;
    Ok(record)
}

pub fn get_inbox(conn: &Connection, id: &str) -> rusqlite::Result<Option<InboxRecord>> {
    conn.query_row("SELECT * FROM inbox WHERE id = ?1", [id], map_inbox)
        .optional()
}

pub fn list_inbox(conn: &Connection) -> rusqlite::Result<Vec<InboxRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM inbox WHERE queue_status = 'proposed' ORDER BY created_at DESC LIMIT 20000",
    )?;
    let rows = stmt.query_map([], map_inbox)?;
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

pub fn find_active_by_hash(conn: &Connection, hash: &str) -> rusqlite::Result<Option<MemoryRecord>> {
    conn.query_row(
        "SELECT * FROM memories WHERE content_hash = ?1 AND status = 'active' LIMIT 1",
        [hash],
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
    let needle = format!("%{}%", query.replace('%', ""));
    let kind = scope_kind.unwrap_or("");
    let id = scope_id.unwrap_or("");
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
        "INSERT INTO api_keys (id, name, token_hash, token_prefix, scopes, tools, created_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            record.id,
            record.name,
            record.token_hash,
            record.token_prefix,
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

pub fn list_keys(conn: &Connection) -> rusqlite::Result<Vec<ApiKeyRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM api_keys ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], map_key)?;
    rows.collect()
}

pub fn touch_key(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2", params![now_iso(), id])?;
    Ok(())
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
    })
}

fn map_key(row: &rusqlite::Row) -> rusqlite::Result<ApiKeyRecord> {
    Ok(ApiKeyRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        token_hash: row.get("token_hash")?,
        token_prefix: row.get("token_prefix")?,
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
