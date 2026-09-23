use crate::config::Config;
use crate::distill::{find_conflicts, should_auto_promote};
use crate::models::{CollectResult, InboxRecord, MemoryRecord};
use crate::scan::scan_and_redact;
use crate::store;
use crate::util::{clip_title, hash_token, new_id, now_iso, sha256_hex};
use rand::RngCore;
use rusqlite::Connection;

pub enum StoreOutcome {
    Stored(MemoryRecord),
    Unchanged(MemoryRecord),
    Conflict(i64),
}

/// 二次验证：对替换后的正文与标题再次扫描。
/// 返回为空表示可以写入；命中非空表示替换不完整或无法证明完整，必须拒收。
fn second_pass_hits(body: &str, title: &str) -> Vec<serde_json::Value> {
    let mut hits = crate::scan::verify_redacted(body);
    for hit in &mut hits {
        hit["field"] = serde_json::json!("body");
    }
    let mut title_hits = crate::scan::verify_redacted(title);
    for hit in &mut title_hits {
        hit["field"] = serde_json::json!("title");
    }
    hits.extend(title_hits);
    hits
}

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
        expected_rev: Option<i64>,
    ) -> serde_json::Value {
        let mut scanned = if config.security.scan_enabled {
            scan_and_redact(body)
        } else {
            crate::scan::ScanResult {
                clean_text: body.to_string(),
                hits: vec![],
                highest: "public".into(),
                locations: vec![],
            }
        };
        let mut title_scan = if config.security.scan_enabled {
            scan_and_redact(title.unwrap_or(""))
        } else {
            crate::scan::ScanResult { clean_text: title.unwrap_or("").into(), hits: vec![], highest: "public".into(), locations: vec![] }
        };
        for location in &mut scanned.locations { location["field"] = serde_json::json!("body"); }
        for location in &mut title_scan.locations { location["field"] = serde_json::json!("title"); }
        if title_scan.highest == "secret" || (title_scan.highest == "pii" && scanned.highest == "public") {
            scanned.highest = title_scan.highest.clone();
        }
        scanned.hits.extend(title_scan.hits);
        scanned.locations.extend(title_scan.locations);
        let hit_types: Vec<&str> = scanned.hits.iter().map(|(kind, _)| kind.as_str()).collect();
        let unsafe_redaction = hit_types.iter().any(|kind| matches!(*kind, "high_entropy" | "private_key_incomplete"));
        // 二次验证：替换后的标题与正文不得再命中任何规则。
        // 命中即说明替换不完整（或无法证明完整），必须拒收。
        let residue = second_pass_hits(&scanned.clean_text, &title_scan.clean_text);
        let collected_scope_kind = scope_kind.unwrap_or("personal");
        let collected_scope_id = scope_id.unwrap_or("");
        if !is_official_distill_source(source) {
            match store::find_collected_inbox(conn, source, collected_scope_kind, collected_scope_id, scanned.clean_text.trim()) {
                Ok(Some(existing)) => return serde_json::json!({"status": "unchanged", "inboxId": existing.id, "redacted": existing.redacted == 1, "queued": existing.queue_status == "proposed", "conflicts": []}),
                Err(_) => return serde_json::json!({"status": "error", "error": "inbox lookup failed"}),
                Ok(None) => {}
            }
        }
        if (scanned.highest == "secret" && unsafe_redaction) || !residue.is_empty() {
            let mut hits = scanned.locations.clone();
            hits.extend(residue.clone());
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
            let Ok(inbox) = store::insert_inbox(conn, inbox) else {
                return serde_json::json!({"status": "error", "error": "inbox write failed"});
            };
            for (kind, _) in &scanned.hits {
                let _ = store::add_redaction(conn, source, &kind, Some(&inbox.id));
            }
            for hit in &residue {
                if let Some(kind) = hit["type"].as_str() {
                    let _ = store::add_redaction(conn, source, kind, Some(&inbox.id));
                }
            }
            let _ = store::audit(conn, actor, "remember.redacted", &inbox.id);
            return serde_json::json!({ "status": "rejected", "inboxId": inbox.id, "redacted": true, "queued": false, "conflicts": [], "hits": hits });
        }
        let text = scanned.clean_text.trim().to_string();
        let scope_kind = scope_kind.unwrap_or("global");
        let scope_id = scope_id.unwrap_or("");
        let title = Some(title_scan.clean_text.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| official_title(scope_kind, scope_id, &text));
        let sensitivity = if scanned.hits.is_empty() { scanned.highest.clone() } else { "public".to_string() };
        let hash = sha256_hex(&format!("{title}\n{text}"));
        let current = match store::list_active_by_scope(conn, scope_kind, scope_id) {
            Ok(items) => items.first().map(|item| item.rev).unwrap_or(0),
            Err(_) => return serde_json::json!({"status": "error", "error": "revision lookup failed"}),
        };
        if expected_rev.is_some_and(|expected| expected != current) || (expected_rev.is_none() && current > 0 && is_official_distill_source(source)) {
            return serde_json::json!({"status": "conflict", "currentRev": current, "expectedRev": expected_rev, "redacted": !scanned.hits.is_empty(), "queued": false, "conflicts": []});
        }
        match store::find_active_by_hash(conn, &hash, scope_kind, scope_id) {
            Ok(Some(existing)) if existing.sensitivity == sensitivity => {
                let _ = store::audit(conn, actor, "remember.dedup", &existing.id);
                return serde_json::json!({ "status": "unchanged", "inboxId": "", "memoryId": existing.id, "rev": existing.rev, "redacted": !scanned.hits.is_empty(), "queued": false, "conflicts": [], "hits": scanned.locations });
            }
            Err(_) => return serde_json::json!({"status": "error", "error": "memory lookup failed"}),
            _ => {}
        }
        let actives = match store::list_active(conn) {
            Ok(items) => items,
            Err(_) => return serde_json::json!({"status": "error", "error": "memory lookup failed"}),
        };
        let conflicts = find_conflicts(&text, &title, &actives);
        let conflict_ids: Vec<String> = conflicts.iter().map(|item| item.id.clone()).collect();
        let auto = should_auto_promote(source, &scanned.highest, conflicts.len(), promote);
        if !auto {
            let inbox = InboxRecord {
                id: new_id("in"),
                title,
                body: text,
                source: source.into(),
                scope_kind: scope_kind.into(),
                scope_id: scope_id.into(),
                sensitivity: if scanned.hits.is_empty() { scanned.highest.clone() } else { "public".into() },
                redacted: if scanned.hits.is_empty() { 0 } else { 1 },
                queue_status: "proposed".into(),
                conflict_ids: conflict_ids.clone(),
                created_at: now_iso(),
            };
            let Ok(inbox) = store::insert_inbox(conn, inbox) else {
                return serde_json::json!({"status": "error", "error": "inbox write failed"});
            };
            for (kind, _) in &scanned.hits {
                if store::add_redaction(conn, source, kind, Some(&inbox.id)).is_err() {
                    return serde_json::json!({"status": "error", "inboxId": inbox.id, "queued": true, "error": "redaction audit failed"});
                }
            }
            let _ = store::audit(conn, actor, "memory.queued", &inbox.id);
            return serde_json::json!({
                "status": "queued",
                "inboxId": inbox.id,
                "redacted": inbox.redacted == 1,
                "queued": true,
                "conflicts": conflict_ids,
                "hits": scanned.locations
            });
        }
        let node = Self::node_id(config);
        let outcome = Self::store_scope_document(conn, &node, scope_kind, scope_id, &title, &text, source, actor, expected_rev, &sensitivity);
        match outcome {
            Ok(StoreOutcome::Stored(memory)) => {
                serde_json::json!({
                    "status": "stored",
                    "inboxId": "",
                    "memoryId": memory.id,
                    "rev": memory.rev,
                    "redacted": !scanned.hits.is_empty(),
                    "queued": false,
                    "conflicts": conflict_ids,
                    "hits": scanned.locations
                })
            }
            Ok(StoreOutcome::Unchanged(memory)) => serde_json::json!({
                "status": "unchanged",
                "inboxId": "",
                "memoryId": memory.id,
                "rev": memory.rev,
                "redacted": !scanned.hits.is_empty(),
                "queued": false,
                "conflicts": conflict_ids,
                "hits": scanned.locations
            }),
            Ok(StoreOutcome::Conflict(rev)) => serde_json::json!({"status": "conflict", "currentRev": rev, "expectedRev": expected_rev, "redacted": !scanned.hits.is_empty(), "queued": false, "conflicts": []}),
            Err(_) => serde_json::json!({"status": "error", "error": "memory write failed", "redacted": !scanned.hits.is_empty(), "queued": false, "hits": scanned.locations}),
        }
    }

    /// 事务内覆盖某一作用域的正式记忆（含审计）。冲突返回 StoreOutcome::Conflict。
    fn store_scope_document(
        conn: &Connection,
        node_id: &str,
        scope_kind: &str,
        scope_id: &str,
        title: &str,
        body: &str,
        source: &str,
        actor: &str,
        expected_rev: Option<i64>,
        sensitivity: &str,
    ) -> rusqlite::Result<StoreOutcome> {
        let tx = conn.unchecked_transaction()?;
        let result = (|| -> rusqlite::Result<StoreOutcome> {
            let same_scope = store::list_active_by_scope(&tx, scope_kind, scope_id)?;
            let current = same_scope.first().map(|item| item.rev).unwrap_or(0);
            if let Some(expected) = expected_rev {
                if current != expected {
                    return Ok(StoreOutcome::Conflict(current));
                }
            }
            let hash = sha256_hex(&format!("{title}\n{body}"));
            let now = now_iso();
            if let Some(keep) = same_scope.first() {
                if keep.content_hash == hash && keep.sensitivity == sensitivity {
                    return Ok(StoreOutcome::Unchanged(keep.clone()));
                }
                let mut next = keep.clone();
                next.rev += 1;
                next.title = title.to_string();
                next.body = body.to_string();
                next.sensitivity = sensitivity.to_string();
                next.status = "active".into();
                next.source = source.into();
                next.content_hash = hash;
                next.superseded_by = None;
                next.updated_at = now.clone();
                next.forgotten_at = None;
                store::upsert_memory(&tx, &next)?;
                for extra in same_scope.iter().skip(1) {
                    let mut extra = extra.clone();
                    extra.rev += 1;
                    extra.status = "forgotten".into();
                    extra.superseded_by = Some(next.id.clone());
                    extra.updated_at = now.clone();
                    extra.forgotten_at = Some(now.clone());
                    store::upsert_memory(&tx, &extra)?;
                }
                store::audit(&tx, actor, "memory.store", &next.id)?;
                return Ok(StoreOutcome::Stored(next));
            }
            let memory = MemoryRecord {
                id: new_id("mem"),
                rev: 1,
                title: title.to_string(),
                body: body.to_string(),
                scope_kind: scope_kind.into(),
                scope_id: scope_id.into(),
                sensitivity: sensitivity.to_string(),
                status: "active".into(),
                source: source.into(),
                origin_node: node_id.to_string(),
                content_hash: hash,
                superseded_by: None,
                created_at: now.clone(),
                updated_at: now,
                forgotten_at: None,
            };
            store::upsert_memory(&tx, &memory)?;
            store::audit(&tx, actor, "memory.store", &memory.id)?;
            Ok(StoreOutcome::Stored(memory))
        })();
        match result {
            Ok(outcome @ (StoreOutcome::Stored(_) | StoreOutcome::Unchanged(_))) => {
                tx.commit()?;
                Ok(outcome)
            }
            Ok(StoreOutcome::Conflict(rev)) => {
                tx.rollback()?;
                Ok(StoreOutcome::Conflict(rev))
            }
            Err(error) => {
                let _ = tx.rollback();
                Err(error)
            }
        }
    }

    /// 管理台“确认所选来源”：单事务校验来源、扫描正文、校验 rev、写入正式记忆、删除来源。
    pub fn confirm_sources(
        conn: &Connection,
        config: &Config,
        ids: &[String],
        body: &str,
        title: Option<&str>,
        actor: &str,
        expected_rev: Option<i64>,
    ) -> serde_json::Value {
        if ids.is_empty() || body.trim().is_empty() {
            return serde_json::json!({"status": "error", "error": "ids and body required"});
        }
        let mut unique = ids.to_vec();
        unique.sort();
        unique.dedup();
        if unique.len() != ids.len() {
            return serde_json::json!({"status": "error", "error": "duplicate source ids"});
        }
        let mut sources = Vec::new();
        for id in ids {
            match store::get_inbox(conn, id) {
                Ok(Some(item)) => sources.push(item),
                _ => return serde_json::json!({"status": "error", "error": "source not found", "inboxId": id}),
            }
        }
        let first = &sources[0];
        if sources.iter().any(|item| {
            item.queue_status != "proposed"
                || item.sensitivity == "secret"
                || item.scope_kind != first.scope_kind
                || item.scope_id != first.scope_id
        }) {
            return serde_json::json!({"status": "error", "error": "sources must be safe and in the same scope"});
        }
        let scope_kind = first.scope_kind.clone();
        let scope_id = first.scope_id.clone();

        let mut scanned = if config.security.scan_enabled { scan_and_redact(body) } else {
            crate::scan::ScanResult { clean_text: body.to_string(), hits: vec![], highest: "public".into(), locations: vec![] }
        };
        let title_scan = if config.security.scan_enabled { scan_and_redact(title.unwrap_or("")) } else {
            crate::scan::ScanResult { clean_text: title.unwrap_or("").into(), hits: vec![], highest: "public".into(), locations: vec![] }
        };
        for location in &mut scanned.locations { location["field"] = serde_json::json!("body"); }
        scanned.hits.extend(title_scan.hits);
        scanned.locations.extend(title_scan.locations);
        if title_scan.highest == "secret" || (title_scan.highest == "pii" && scanned.highest == "public") {
            scanned.highest = title_scan.highest.clone();
        }
        let hit_types: Vec<&str> = scanned.hits.iter().map(|(kind, _)| kind.as_str()).collect();
        let residue = second_pass_hits(&scanned.clean_text, &title_scan.clean_text);
        if (scanned.highest == "secret"
            && hit_types.iter().any(|kind| matches!(*kind, "high_entropy" | "private_key_incomplete")))
            || !residue.is_empty()
        {
            let mut hits = scanned.locations.clone();
            hits.extend(residue);
            return serde_json::json!({"status": "rejected", "redacted": true, "queued": false, "conflicts": [], "hits": hits});
        }
        let text = scanned.clean_text.trim().to_string();
        let title = Some(title_scan.clean_text.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| official_title(&scope_kind, &scope_id, &text));
        let sensitivity = if scanned.hits.is_empty() { scanned.highest.clone() } else { "public".to_string() };

        let tx = match conn.unchecked_transaction() {
            Ok(tx) => tx,
            Err(_) => return serde_json::json!({"status": "error", "error": "transaction failed"}),
        };
        let outcome = (|| -> rusqlite::Result<serde_json::Value> {
            // 事务内复核来源仍存在且状态未变
            for id in ids {
                let Some(item) = store::get_inbox(&tx, id)? else {
                    return Ok(serde_json::json!({"status": "error", "error": "source changed", "inboxId": id}));
                };
                if item.queue_status != "proposed" || item.sensitivity == "secret" {
                    return Ok(serde_json::json!({"status": "error", "error": "source changed", "inboxId": id}));
                }
            }
            let same_scope = store::list_active_by_scope(&tx, &scope_kind, &scope_id)?;
            let current = same_scope.first().map(|item| item.rev).unwrap_or(0);
            let hash = sha256_hex(&format!("{title}\n{text}"));
            let now = now_iso();
            if let Some(expected) = expected_rev {
                if current != expected {
                    return Ok(serde_json::json!({"status": "conflict", "currentRev": current, "expectedRev": expected_rev, "queued": false, "conflicts": []}));
                }
            } else if current > 0 {
                return Ok(serde_json::json!({"status": "conflict", "currentRev": current, "queued": false, "conflicts": []}));
            }
            let unchanged = same_scope
                .first()
                .is_some_and(|keep| keep.content_hash == hash && keep.sensitivity == sensitivity);
            let memory = if unchanged {
                same_scope.first().unwrap().clone()
            } else if let Some(keep) = same_scope.first() {
                let mut next = keep.clone();
                next.rev += 1;
                next.title = title.clone();
                next.body = text.clone();
                next.sensitivity = sensitivity.clone();
                next.status = "active".into();
                next.source = "ui".into();
                next.content_hash = hash;
                next.superseded_by = None;
                next.updated_at = now.clone();
                next.forgotten_at = None;
                store::upsert_memory(&tx, &next)?;
                for extra in same_scope.iter().skip(1) {
                    let mut extra = extra.clone();
                    extra.rev += 1;
                    extra.status = "forgotten".into();
                    extra.superseded_by = Some(next.id.clone());
                    extra.updated_at = now.clone();
                    extra.forgotten_at = Some(now.clone());
                    store::upsert_memory(&tx, &extra)?;
                }
                next
            } else {
                let memory = MemoryRecord {
                    id: new_id("mem"),
                    rev: 1,
                    title: title.clone(),
                    body: text.clone(),
                    scope_kind: scope_kind.clone(),
                    scope_id: scope_id.clone(),
                    sensitivity: sensitivity.clone(),
                    status: "active".into(),
                    source: "ui".into(),
                    origin_node: Self::node_id(config),
                    content_hash: hash,
                    superseded_by: None,
                    created_at: now.clone(),
                    updated_at: now,
                    forgotten_at: None,
                };
                store::upsert_memory(&tx, &memory)?;
                memory
            };
            store::audit(&tx, actor, "memory.resolve", &memory.id)?;
            for source in &sources {
                store::delete_inbox(&tx, &source.id)?;
            }
            Ok(serde_json::json!({
                "status": if unchanged { "unchanged" } else { "stored" },
                "memoryId": memory.id,
                "rev": memory.rev,
                "redacted": !scanned.hits.is_empty(),
                "queued": false,
                "conflicts": [],
                "hits": scanned.locations
            }))
        })();
        match outcome {
            Ok(value) if value["status"] == "stored" || value["status"] == "unchanged" => {
                match tx.commit() {
                    Ok(()) => value,
                    Err(_) => serde_json::json!({"status": "error", "error": "commit failed"}),
                }
            }
            Ok(value) => {
                let _ = tx.rollback();
                value
            }
            Err(_) => {
                let _ = tx.rollback();
                serde_json::json!({"status": "error", "error": "resolve failed"})
            }
        }
    }

    #[cfg(test)]
    pub fn promote_inbox(
        conn: &Connection,
        config: &Config,
        inbox_id: &str,
        actor: &str,
        expected_rev: Option<i64>,
    ) -> rusqlite::Result<Option<MemoryRecord>> {
        let Some(inbox) = store::get_inbox(conn, inbox_id)? else { return Ok(None); };
        if inbox.sensitivity == "secret" || inbox.queue_status == "rejected" {
            return Ok(None);
        }
        let tx = conn.unchecked_transaction()?;
        let same_scope = store::list_active_by_scope(&tx, &inbox.scope_kind, &inbox.scope_id)?;
        if let Some(expected) = expected_rev {
            let current = same_scope.first().map(|item| item.rev).unwrap_or(0);
            if current != expected {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
        }
        let now = now_iso();
        let hash = sha256_hex(&format!("{}\n{}", inbox.title, inbox.body));
        let memory = if let Some(keep) = same_scope.first() {
            let mut keep = keep.clone();
            keep.rev += 1;
            keep.title = inbox.title.clone();
            keep.body = inbox.body.clone();
            keep.sensitivity = inbox.sensitivity.clone();
            keep.status = "active".into();
            keep.source = inbox.source.clone();
            keep.content_hash = hash;
            keep.superseded_by = None;
            keep.updated_at = now.clone();
            keep.forgotten_at = None;
            keep
        } else {
            MemoryRecord {
                id: new_id("mem"),
                rev: 1,
                title: inbox.title.clone(),
                body: inbox.body.clone(),
                scope_kind: inbox.scope_kind.clone(),
                scope_id: inbox.scope_id.clone(),
                sensitivity: inbox.sensitivity.clone(),
                status: "active".into(),
                source: inbox.source.clone(),
                origin_node: Self::node_id(config),
                content_hash: hash,
                superseded_by: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                forgotten_at: None,
            }
        };
        store::upsert_memory(&tx, &memory)?;
        for extra in same_scope {
            if extra.id == memory.id {
                continue;
            }
            let mut extra = extra;
            extra.rev += 1;
            extra.status = "forgotten".into();
            extra.superseded_by = Some(memory.id.clone());
            extra.updated_at = now.clone();
            extra.forgotten_at = Some(now.clone());
            store::upsert_memory(&tx, &extra)?;
        }
        store::delete_inbox(&tx, &inbox.id)?;
        store::audit(&tx, actor, "memory.promote", &memory.id)?;
        tx.commit()?;
        Ok(Some(memory))
    }

    pub fn reject_inbox(conn: &Connection, inbox_id: &str, actor: &str) -> bool {
        if store::get_inbox(conn, inbox_id).ok().flatten().is_none() {
            return false;
        }
        let _ = store::reject_inbox(conn, inbox_id);
        let _ = store::audit(conn, actor, "memory.reject", inbox_id);
        true
    }

    /// 维护用：清退非蒸馏来源的旧碎片。只由管理员显式触发，不挂在查询或启动流程上。
    #[allow(dead_code)]
    pub fn retire_non_distilled(conn: &Connection) -> i64 {
        let actives = store::list_active(conn).unwrap_or_default();
        let mut removed = 0;
        for item in actives {
            if is_official_distill_source(&item.source) {
                continue;
            }
            if Self::forget(conn, &item.id, "system:retire-fragments") {
                removed += 1;
            }
        }
        removed
    }

    pub fn search(
        conn: &Connection,
        config: &Config,
        query: &str,
        actor: &str,
        limit: i64,
        scope_kind: Option<&str>,
        scope_id: Option<&str>,
    ) -> Vec<MemoryRecord> {
        let raw = store::search_memories(conn, query, limit, scope_kind, scope_id).unwrap_or_default();
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
        let safe_query = scan_and_redact(query).clean_text;
        let _ = store::audit(conn, actor, "memory.search", &safe_query.chars().take(80).collect::<String>());
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

    pub fn get(
        conn: &Connection,
        config: &Config,
        actor: &str,
        id: Option<&str>,
        scope_kind: Option<&str>,
        scope_id: Option<&str>,
    ) -> Vec<MemoryRecord> {
        let id = id.filter(|item| !item.is_empty());
        let scope_kind = scope_kind.filter(|item| !item.is_empty());
        let scope_id = scope_id.filter(|item| !item.is_empty());
        if id.is_none() && scope_kind.is_none() && scope_id.is_none() {
            return vec![];
        }
        let raw = if let Some(id) = id {
            store::get_memory(conn, id).ok().flatten().into_iter().collect()
        } else {
            store::list_memories(conn, 50, scope_kind, scope_id).unwrap_or_default()
        };
        let allow_internal = config.security.allow_internal_in_search;
        let filtered: Vec<MemoryRecord> = raw
            .into_iter()
            .filter(|item| item.status != "forgotten")
            .filter(|item| match item.sensitivity.as_str() {
                "secret" | "pii" => false,
                "internal" => allow_internal,
                "public" => true,
                _ => false,
            })
            .map(Self::for_agent)
            .collect();
        let detail = id
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}:{}", scope_kind.unwrap_or(""), scope_id.unwrap_or("")));
        let _ = store::audit(conn, actor, "memory.get", &detail.chars().take(80).collect::<String>());
        filtered
    }

    pub fn list(
        conn: &Connection,
        limit: i64,
        scope_kind: Option<&str>,
        scope_id: Option<&str>,
    ) -> Vec<MemoryRecord> {
        store::list_memories(conn, limit, scope_kind, scope_id)
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
            let scope_kind = if scope_id.is_empty() { "personal" } else { "project" };
            let raw_hash = sha256_hex(text);
            match store::latest_fingerprint(conn, source, path, scope_kind, scope_id, crate::util::SCAN_RULES_VERSION) {
                Ok(Some(fp)) if fp.content_hash == raw_hash => {
                    let _ = store::touch_fingerprint(conn, &fp.id, "unchanged");
                    skipped += 1;
                    continue;
                }
                Err(_) => {
                    skipped += 1;
                    continue;
                }
                _ => {}
            }
            let result = Self::remember(
                conn,
                &config,
                text,
                Some(&clip_title(text, path)),
                source,
                Some(scope_kind),
                Some(scope_id),
                &format!("collector:{source}"),
                false,
                None,
            );
            let status = result["status"].as_str().unwrap_or("error");
            if status == "unchanged" {
                skipped += 1;
            } else if status == "error" {
                // 写入失败不得登记指纹，下一轮重试
                skipped += 1;
                continue;
            } else if status == "rejected" {
                redacted += 1;
            } else if result.get("memoryId").and_then(|v| v.as_str()).is_some() {
                ingested += 1;
            } else if result["queued"].as_bool().unwrap_or(false) {
                queued += 1;
            } else {
                skipped += 1;
            }
            if status != "unchanged" {
                let _ = store::insert_fingerprint(
                    conn,
                    source,
                    path,
                    scope_kind,
                    scope_id,
                    &raw_hash,
                    crate::util::SCAN_RULES_VERSION,
                    status,
                );
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
            tools: "memory.search,memory.remember,memory.forget,memory.list,memory.get".into(),
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

fn is_official_distill_source(source: &str) -> bool {
    source == "ui" || source.starts_with("ui:") || source.starts_with("mcp:")
}

fn official_title(scope_kind: &str, scope_id: &str, text: &str) -> String {
    if scope_kind == "project" && !scope_id.is_empty() {
        return format!("项目 {scope_id}");
    }
    if scope_kind == "personal" {
        return "个人记忆".into();
    }
    if text.contains('\n') || text.chars().count() > 80 {
        return "蒸馏记忆".into();
    }
    clip_title(text, "蒸馏记忆")
}

#[cfg(test)]
mod tests {
    use super::MemoryService;
    use crate::{config, db, store};

    fn queue_source(conn: &rusqlite::Connection, config: &crate::config::Config, body: &str) -> String {
        let result = MemoryService::remember(conn, config, body, None, "cursor", Some("project"), Some("OneLedger"), "collector:cursor", false, None);
        assert_eq!(result["status"], "queued");
        result["inboxId"].as_str().unwrap().to_string()
    }

    #[test]
    fn failed_direct_write_returns_error_without_inbox() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        conn.execute_batch("CREATE TRIGGER fail_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'failure'); END;")
            .expect("trigger");
        let result = MemoryService::remember(&conn, &config, "可靠写入应保留材料", None, "mcp:test", Some("project"), Some("OneLedger"), "test", false, Some(0));
        assert_eq!(result["status"], "error");
        assert!(store::list_inbox(&conn).expect("inbox").is_empty());
        assert!(store::list_active(&conn).expect("memories").is_empty());
    }

    #[test]
    fn failed_promotion_keeps_the_inbox_source() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let queued = queue_source(&conn, &config, "可靠写入应保留材料");
        conn.execute_batch("CREATE TRIGGER fail_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'failure'); END;")
            .expect("trigger");
        assert!(MemoryService::promote_inbox(&conn, &config, &queued, "test", Some(0)).is_err());
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
        assert!(store::list_active(&conn).expect("memories").is_empty());
        conn.execute_batch("DROP TRIGGER fail_memory").expect("drop trigger");
        let promoted = MemoryService::promote_inbox(&conn, &config, &queued, "test", Some(0)).expect("promote");
        assert!(promoted.is_some());
        assert!(store::list_inbox(&conn).expect("inbox").is_empty());
    }

    #[test]
    fn confirm_sources_rolls_back_when_a_delete_fails() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let first = queue_source(&conn, &config, "第一条采集材料需要蒸馏");
        let second = queue_source(&conn, &config, "第二条采集材料等待确认");
        conn.execute_batch("CREATE TRIGGER fail_inbox_delete BEFORE DELETE ON inbox BEGIN SELECT RAISE(ABORT, 'failure'); END;")
            .expect("trigger");
        let result = MemoryService::confirm_sources(&conn, &config, &[first.clone(), second.clone()], "蒸馏后的整篇项目记忆", None, "admin", Some(0));
        assert_eq!(result["status"], "error");
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 2);
        assert!(store::list_active(&conn).expect("memories").is_empty());
        conn.execute_batch("DROP TRIGGER fail_inbox_delete").expect("drop trigger");
        let result = MemoryService::confirm_sources(&conn, &config, &[first, second], "蒸馏后的整篇项目记忆", None, "admin", Some(0));
        assert_eq!(result["status"], "stored");
        assert_eq!(result["rev"], 1);
        assert!(store::list_inbox(&conn).expect("inbox").is_empty());
        let active = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert_eq!(active[0].body, "蒸馏后的整篇项目记忆");
    }

    #[test]
    fn confirm_sources_conflict_keeps_sources_and_memory() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let first = MemoryService::remember(&conn, &config, "已有项目记忆", None, "mcp:a", Some("project"), Some("OneLedger"), "a", false, Some(0));
        assert_eq!(first["status"], "stored");
        let source = queue_source(&conn, &config, "新的采集材料");
        let result = MemoryService::confirm_sources(&conn, &config, &[source], "管理台编辑的整篇", None, "admin", Some(0));
        assert_eq!(result["status"], "conflict");
        assert_eq!(result["currentRev"], 1);
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
        let active = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert_eq!(active[0].body, "已有项目记忆");
    }

    #[test]
    fn repeated_confirm_after_success_does_not_revert_newer_revision() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue_source(&conn, &config, "采集材料准备确认");
        let first = MemoryService::confirm_sources(&conn, &config, std::slice::from_ref(&source), "第一版蒸馏", None, "admin", Some(0));
        assert_eq!(first["status"], "stored");
        // 另一个 Agent 已推进 rev
        let advanced = MemoryService::remember(&conn, &config, "第二版蒸馏", None, "mcp:agent", Some("project"), Some("OneLedger"), "agent", false, Some(1));
        assert_eq!(advanced["status"], "stored");
        // 重复提交同一来源：来源已删除，不应覆盖新版本
        let replay = MemoryService::confirm_sources(&conn, &config, &[source], "第一版蒸馏", None, "admin", Some(0));
        assert_eq!(replay["status"], "error");
        let active = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert_eq!(active[0].body, "第二版蒸馏");
        assert_eq!(active[0].rev, 2);
    }

    #[test]
    fn collect_fingerprint_survives_inbox_lifecycle() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let files = vec![(
            "C:/work/OneLedger/AGENTS.md".to_string(),
            "项目约定内容版本一".to_string(),
            "OneLedger".to_string(),
        )];
        let first = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(first.queued, 1);
        // 同一文件再次扫描：指纹命中，不产生新 inbox
        let second = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(second.queued, 0);
        assert_eq!(second.skipped, 1);
        // 管理台确认后删除 inbox，再扫描仍不产生新 inbox
        let inbox = store::list_inbox(&conn).expect("inbox");
        let confirmed = MemoryService::confirm_sources(&conn, &config, &[inbox[0].id.clone()], "蒸馏整篇", None, "admin", Some(0));
        assert_eq!(confirmed["status"], "stored");
        let third = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(third.queued, 0);
        assert_eq!(third.skipped, 1);
        assert!(store::list_inbox(&conn).expect("inbox").is_empty());
        // 文件内容变化：产生一个新版本
        let changed = vec![(files[0].0.clone(), "项目约定内容版本二".to_string(), "OneLedger".to_string())];
        let fourth = MemoryService::ingest_collected(&conn, "projects", &changed);
        assert_eq!(fourth.queued, 1);
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
    }

    #[test]
    fn stale_revision_cannot_overwrite_scope() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let first = MemoryService::remember(&conn, &config, "项目说明第一版", None, "mcp:a", Some("project"), Some("OneLedger"), "a", false, Some(0));
        assert_eq!(first["status"], "stored");
        let stale = MemoryService::remember(&conn, &config, "项目说明旧稿", None, "mcp:b", Some("project"), Some("OneLedger"), "b", false, Some(0));
        assert_eq!(stale["status"], "conflict");
        assert_eq!(stale["currentRev"], 1);
        let items = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert_eq!(items[0].body, "项目说明第一版");
    }

    #[test]
    fn secret_in_title_is_redacted_before_listing() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let result = MemoryService::remember(&conn, &config, "正常的项目说明", Some("凭据 sk-abcdefghijklmnopqrstuvwxyz123456"), "mcp:test", Some("project"), Some("OneLedger"), "test", false, Some(0));
        assert_eq!(result["status"], "stored");
        let items = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert!(items[0].title.contains("[REDACTED:openai_key]"));
        assert!(!items[0].title.contains("sk-abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn reads_do_not_retire_collector_fragments() {        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        // 直接写入一条来源为采集器的 active 记忆（旧碎片）
        conn.execute(
            "INSERT INTO memories (id, rev, title, body, scope_kind, scope_id, sensitivity, status, source, origin_node, content_hash, created_at, updated_at)
             VALUES ('frag', 1, '旧碎片', '采集器残留', 'project', 'OneLedger', 'public', 'active', 'cursor', 'local', 'h', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')",
            [],
        )
        .expect("insert fragment");
        let _ = MemoryService::search(&conn, &config, "残留", "agent", 8, None, None);
        let _ = MemoryService::list(&conn, 10, None, None);
        let _ = MemoryService::get(&conn, &config, "agent", Some("frag"), None, None);
        let item = store::get_memory(&conn, "frag").expect("row").expect("memory");
        assert_eq!(item.status, "active");
        assert_eq!(item.rev, 1);
        assert_eq!(item.updated_at, "2024-01-01T00:00:00.000Z");
    }
}
