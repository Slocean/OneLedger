use crate::config::Config;
use crate::distill::{distill_text, find_conflicts, should_auto_promote};
use crate::models::{CollectResult, InboxRecord, MemoryRecord};
use crate::scan::scan_and_redact;
use crate::store;
use crate::util::{clip_title, hash_token, new_id, now_iso, sha256_hex};
use rand::RngCore;
use rusqlite::Connection;

pub struct MemoryService;

impl MemoryService {
    pub fn node_id(config: &Config) -> String {
        let key = &config.sync.node_key;
        if key.len() >= 8 {
            key[..8].to_string()
        } else {
            "local".into()
        }
    }

    pub fn remember(
        conn: &Connection,
        config: &Config,
        body: &str,
        title: Option<&str>,
        source: &str,
        scope_kind: Option<&str>,
        scope_id: Option<&str>,
        actor: &str,
        promote: bool,
    ) -> serde_json::Value {
        let scanned = if config.security.scan_enabled {
            scan_and_redact(body)
        } else {
            crate::scan::ScanResult {
                clean_text: body.to_string(),
                hits: vec![],
                highest: "public".into(),
            }
        };
        if scanned.highest == "secret" {
            let inbox = InboxRecord {
                id: new_id("in"),
                title: clip_title(&scanned.clean_text, "Redacted note"),
                body: scanned.clean_text,
                source: source.into(),
                scope_kind: scope_kind.unwrap_or("personal").into(),
                scope_id: scope_id.unwrap_or("").into(),
                sensitivity: "secret".into(),
                redacted: 1,
                queue_status: "rejected".into(),
                conflict_ids: vec![],
                created_at: now_iso(),
            };
            let inbox = store::insert_inbox(conn, inbox).expect("inbox");
            for (kind, _) in scanned.hits {
                let _ = store::add_redaction(conn, source, &kind, Some(&inbox.id));
            }
            let _ = store::audit(conn, actor, "remember.redacted", &inbox.id);
            return serde_json::json!({ "inboxId": inbox.id, "redacted": true, "queued": false, "conflicts": [] });
        }
        let distilled = distill_text(config, &scanned.clean_text);
        let title = title
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| clip_title(&distilled, "Untitled"));
        let hash = sha256_hex(&format!("{title}\n{distilled}"));
        if let Ok(Some(existing)) = store::find_active_by_hash(conn, &hash) {
            let _ = store::audit(conn, actor, "remember.dedup", &existing.id);
            return serde_json::json!({ "inboxId": "", "memoryId": existing.id, "redacted": false, "queued": false, "conflicts": [] });
        }
        let actives = store::list_active(conn).unwrap_or_default();
        let conflicts = find_conflicts(&distilled, &title, &actives);
        let conflict_ids: Vec<String> = conflicts.iter().map(|item| item.id.clone()).collect();
        let inbox = InboxRecord {
            id: new_id("in"),
            title,
            body: distilled,
            source: source.into(),
            scope_kind: scope_kind.unwrap_or("global").into(),
            scope_id: scope_id.unwrap_or("").into(),
            sensitivity: scanned.highest.clone(),
            redacted: if scanned.hits.is_empty() { 0 } else { 1 },
            queue_status: "proposed".into(),
            conflict_ids: conflict_ids.clone(),
            created_at: now_iso(),
        };
        let inbox = store::insert_inbox(conn, inbox).expect("inbox");
        if should_auto_promote(source, &scanned.highest, conflicts.len(), promote) {
            let memory = Self::promote_inbox(conn, config, &inbox.id, actor, &conflict_ids);
            return serde_json::json!({
                "inboxId": inbox.id,
                "memoryId": memory.as_ref().map(|item| item.id.clone()),
                "redacted": inbox.redacted == 1,
                "queued": false,
                "conflicts": conflict_ids
            });
        }
        let _ = store::audit(conn, actor, "memory.queued", &inbox.id);
        serde_json::json!({
            "inboxId": inbox.id,
            "redacted": inbox.redacted == 1,
            "queued": true,
            "conflicts": conflict_ids
        })
    }

    pub fn promote_inbox(
        conn: &Connection,
        config: &Config,
        inbox_id: &str,
        actor: &str,
        supersede_ids: &[String],
    ) -> Option<MemoryRecord> {
        let inbox = store::get_inbox(conn, inbox_id).ok().flatten()?;
        if inbox.sensitivity == "secret" || inbox.queue_status == "rejected" {
            return None;
        }
        let memory = MemoryRecord {
            id: new_id("mem"),
            rev: 1,
            title: inbox.title.clone(),
            body: inbox.body.clone(),
            scope_kind: inbox.scope_kind,
            scope_id: inbox.scope_id,
            sensitivity: inbox.sensitivity,
            status: "active".into(),
            source: inbox.source,
            origin_node: Self::node_id(config),
            content_hash: sha256_hex(&format!("{}\n{}", inbox.title, inbox.body)),
            superseded_by: None,
            created_at: now_iso(),
            updated_at: now_iso(),
            forgotten_at: None,
        };
        let _ = store::upsert_memory(conn, &memory);
        let ids = if supersede_ids.is_empty() {
            inbox.conflict_ids
        } else {
            supersede_ids.to_vec()
        };
        for old_id in ids {
            if let Ok(Some(mut current)) = store::get_memory(conn, &old_id) {
                if current.status != "active" {
                    continue;
                }
                current.rev += 1;
                current.status = "forgotten".into();
                current.superseded_by = Some(memory.id.clone());
                current.updated_at = now_iso();
                current.forgotten_at = Some(now_iso());
                let _ = store::upsert_memory(conn, &current);
            }
        }
        let _ = store::delete_inbox(conn, &inbox.id);
        let _ = store::audit(conn, actor, "memory.promote", &memory.id);
        Some(memory)
    }

    pub fn reject_inbox(conn: &Connection, inbox_id: &str, actor: &str) -> bool {
        if store::get_inbox(conn, inbox_id).ok().flatten().is_none() {
            return false;
        }
        let _ = store::reject_inbox(conn, inbox_id);
        let _ = store::audit(conn, actor, "memory.reject", inbox_id);
        true
    }

    pub fn search(conn: &Connection, config: &Config, query: &str, actor: &str, limit: i64) -> Vec<MemoryRecord> {
        let raw = store::search_memories(conn, query, limit).unwrap_or_default();
        let allow_internal = config.security.allow_internal_in_search;
        let filtered = raw
            .into_iter()
            .filter(|item| match item.sensitivity.as_str() {
                "secret" | "pii" => false,
                "internal" => allow_internal,
                "public" => true,
                _ => false,
            })
            .map(Self::for_agent)
            .collect();
        let _ = store::audit(conn, actor, "memory.search", &query.chars().take(80).collect::<String>());
        filtered
    }

    pub fn forget(conn: &Connection, id: &str, actor: &str) -> bool {
        let Some(mut current) = store::get_memory(conn, id).ok().flatten() else {
            return false;
        };
        current.rev += 1;
        current.status = "forgotten".into();
        current.updated_at = now_iso();
        current.forgotten_at = Some(now_iso());
        let _ = store::upsert_memory(conn, &current);
        let _ = store::audit(conn, actor, "memory.forget", id);
        true
    }

    pub fn list(conn: &Connection, limit: i64) -> Vec<MemoryRecord> {
        store::list_memories(conn, limit)
            .unwrap_or_default()
            .into_iter()
            .map(Self::for_agent)
            .collect()
    }

    pub fn ingest_collected(conn: &Connection, source: &str, files: &[(String, String, String)]) -> CollectResult {
        let mut ingested = 0;
        let mut queued = 0;
        let mut skipped = 0;
        let mut redacted = 0;
        let config = crate::config::load_config();
        for (path, text, scope_id) in files {
            let text = text.trim();
            if text.len() < 8 {
                skipped += 1;
                continue;
            }
            let result = Self::remember(
                conn,
                &config,
                text,
                Some(&clip_title(text, path)),
                source,
                Some(if scope_id.is_empty() { "personal" } else { "project" }),
                Some(scope_id),
                &format!("collector:{source}"),
                false,
            );
            if result["redacted"].as_bool().unwrap_or(false) {
                redacted += 1;
            } else if result.get("memoryId").and_then(|v| v.as_str()).is_some() {
                ingested += 1;
            } else if result["queued"].as_bool().unwrap_or(false) {
                queued += 1;
            } else {
                skipped += 1;
            }
        }
        CollectResult {
            source: source.into(),
            scanned_files: files.len() as i64,
            ingested,
            queued,
            skipped,
            redacted,
        }
    }

    pub fn issue_key(conn: &Connection, name: &str) -> serde_json::Value {
        let mut raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = format!("ol_{}", hex::encode(raw));
        let record = crate::models::ApiKeyRecord {
            id: new_id("key"),
            name: name.to_string(),
            token_hash: hash_token(&token),
            token_prefix: token.chars().take(8).collect(),
            scopes: "global,project,personal".into(),
            tools: "memory.search,memory.remember,memory.forget,memory.list".into(),
            created_at: now_iso(),
            last_used_at: None,
        };
        let _ = store::insert_key(conn, &record);
        let _ = store::audit(conn, "admin", "key.create", &record.id);
        serde_json::json!({
            "id": record.id,
            "name": record.name,
            "token": token,
            "prefix": record.token_prefix
        })
    }

    fn for_agent(mut memory: MemoryRecord) -> MemoryRecord {
        if memory.sensitivity == "secret" {
            memory.body = "[REDACTED:secret]".into();
        }
        memory
    }
}
