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
        let tx = match conn.unchecked_transaction() {
            Ok(tx) => tx,
            Err(_) => return serde_json::json!({"status": "error", "error": "transaction failed"}),
        };
        let result = Self::remember_tx(
            &tx, config, body, title, source, scope_kind, scope_id, actor, promote, expected_rev, "",
        );
        match result["status"].as_str() {
            Some("stored") | Some("unchanged") | Some("queued") | Some("rejected") => match tx.commit() {
                Ok(()) => result,
                Err(_) => serde_json::json!({"status": "error", "error": "commit failed"}),
            },
            _ => {
                let _ = tx.rollback();
                result
            }
        }
    }

    /// remember 的事务内实现：调用方负责事务边界（remember 与 ingest_collected 各自开事务）。
    /// source_key 是材料的稳定来源键（canonical 绝对路径或采集上报的原始路径）；
    /// UI/MCP 直写为空串，与人工/历史行同键互认（B-05）。
    #[allow(clippy::too_many_arguments)]
    pub fn remember_tx(
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
        source_key: &str,
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
            match store::find_collected_inbox(conn, source, collected_scope_kind, collected_scope_id, scanned.clean_text.trim(), source_key) {
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
                source_key: source_key.into(),
            };
            let Ok(inbox) = store::insert_inbox(conn, inbox) else {
                return serde_json::json!({"status": "error", "error": "inbox write failed"});
            };
            for (kind, _) in &scanned.hits {
                if store::add_redaction(conn, source, &kind, Some(&inbox.id)).is_err() {
                    return serde_json::json!({"status": "error", "error": "redaction audit failed"});
                }
            }
            for hit in &residue {
                if let Some(kind) = hit["type"].as_str() {
                    if store::add_redaction(conn, source, kind, Some(&inbox.id)).is_err() {
                        return serde_json::json!({"status": "error", "error": "redaction audit failed"});
                    }
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
                source_key: source_key.into(),
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

    /// 事务内覆盖某一作用域的正式记忆（含审计）。调用方负责事务边界与提交；
    /// 冲突返回 StoreOutcome::Conflict，由调用方决定回滚。
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
        let result = (|| -> rusqlite::Result<StoreOutcome> {
            let same_scope = store::list_active_by_scope(conn, scope_kind, scope_id)?;
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
                store::upsert_memory(conn, &next)?;
                for extra in same_scope.iter().skip(1) {
                    let mut extra = extra.clone();
                    extra.rev += 1;
                    extra.status = "forgotten".into();
                    extra.superseded_by = Some(next.id.clone());
                    extra.updated_at = now.clone();
                    extra.forgotten_at = Some(now.clone());
                    store::upsert_memory(conn, &extra)?;
                }
                store::audit(conn, actor, "memory.store", &next.id)?;
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
            store::upsert_memory(conn, &memory)?;
            store::audit(conn, actor, "memory.store", &memory.id)?;
            Ok(StoreOutcome::Stored(memory))
        })()?;
        Ok(result)
    }

    /// 管理台“确认所选来源”：单事务校验来源、扫描正文、校验 rev、写入正式记忆、删除来源。
    /// draft_id 提供时必须与该待审草稿的来源集合一致，成功后草稿标记为已应用；
    /// 未提供且作用域存在待审草稿时拒绝，防止绕过草稿审核的隐式路径（P0-01）。
    pub fn confirm_sources(
        conn: &Connection,
        config: &Config,
        ids: &[String],
        body: &str,
        title: Option<&str>,
        actor: &str,
        expected_rev: Option<i64>,
        draft_id: Option<&str>,
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
        // C-05：人工确认批量上限——超限整体拒绝、零写入，避免 13.7 万条进入单个长事务。
        const MAX_CONFIRM_SOURCES: usize = 100;
        if ids.len() > MAX_CONFIRM_SOURCES {
            return serde_json::json!({
                "status": "error",
                "error": format!("一次最多确认 {MAX_CONFIRM_SOURCES} 条来源（本次 {} 条）；请分批勾选并提交", ids.len()),
            });
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

        // 草稿路径复核（P0-01）：draft 模式校验草稿状态与来源集合；manual 模式拒绝绕过待审草稿。
        let mut draft_applies: Option<crate::distill_job::DistillDraft> = None;
        match draft_id {
            Some(id) => {
                let Some(draft) = crate::distill_job::get_draft(conn, id).ok().flatten() else {
                    return serde_json::json!({"status": "error", "error": "草稿不存在或已删除", "draftId": id});
                };
                if draft.status != "pending" {
                    return serde_json::json!({"status": "error", "error": format!("草稿状态为 {}，过期草稿禁止直接提交，请重新整理", draft.status)});
                }
                if draft.scope_kind != scope_kind || draft.scope_id != scope_id {
                    return serde_json::json!({"status": "error", "error": "草稿作用域与所选材料不一致"});
                }
                let mut expected = draft.source_ids.clone();
                expected.sort();
                let mut actual = ids.to_vec();
                actual.sort();
                if expected != actual {
                    return serde_json::json!({"status": "error", "error": "提交的来源集合与草稿记录不一致，请重新核对草稿来源"});
                }
                draft_applies = Some(draft);
            }
            None => {
                if let Ok(Some(pending)) = crate::distill_job::latest_draft(conn, &scope_kind, &scope_id) {
                    if pending.status == "pending" {
                        return serde_json::json!({
                            "status": "error",
                            "error": "该作用域存在待审核草稿：请通过草稿入口审核提交，或先废弃草稿再手工整理",
                            "draftId": pending.id,
                        });
                    }
                }
            }
        }

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
            // 事务内复核来源仍存在、状态未变、仍在同一作用域（归并可能已移动材料）
            let mut fresh_sources: Vec<crate::models::InboxRecord> = Vec::new();
            for id in ids {
                let Some(item) = store::get_inbox(&tx, id)? else {
                    return Ok(serde_json::json!({"status": "error", "error": "source changed", "inboxId": id}));
                };
                if item.queue_status != "proposed"
                    || item.sensitivity == "secret"
                    || item.scope_kind != scope_kind
                    || item.scope_id != scope_id
                {
                    return Ok(serde_json::json!({"status": "error", "error": "source changed", "inboxId": id}));
                }
                fresh_sources.push(item);
            }
            // 第五轮修复（来源内容二次复核）：sensitivity 标记可能过期或被篡改
            // （legacy 行、备份导入行、被直接改库的 public 行），确认事务内必须对每条 fresh
            // 来源的标题与正文重新安全扫描；任一命中即整批拒绝，正式记忆、全部来源与审计
            // 保持原状。错误信息只报命中类型与数量，不回显来源正文。
            // 无条件执行：与 second_pass_hits 的最终安全门一致，不随 security.scan_enabled 关闭
            // ——扫描开关只省掉入队时的替换劳动，不能豁免确认时的来源安全复核。
            {
                let mut source_hits: Vec<serde_json::Value> = Vec::new();
                let mut source_hit_kinds: Vec<String> = Vec::new();
                for item in &fresh_sources {
                    for (field, text) in [("sourceBody", item.body.as_str()), ("sourceTitle", item.title.as_str())] {
                        let scan = scan_and_redact(text);
                        for (kind, _) in &scan.hits {
                            source_hits.push(serde_json::json!({"type": kind, "field": field}));
                            if !source_hit_kinds.iter().any(|known| known == kind) {
                                source_hit_kinds.push(kind.clone());
                            }
                        }
                    }
                }
                if !source_hits.is_empty() {
                    let kinds = source_hit_kinds.join("/");
                    let error = format!(
                        "来源标题或正文安全复核未通过（{} 处命中：{kinds}）：敏感标记可能过期，已整批拒绝并保留全部来源；请逐条拒收或重新蒸馏",
                        source_hits.len(),
                    );
                    return Ok(serde_json::json!({
                        "status": "rejected",
                        "redacted": true,
                        "queued": false,
                        "conflicts": [],
                        "hits": source_hits,
                        "error": error,
                    }));
                }
            }
            let same_scope = store::list_active_by_scope(&tx, &scope_kind, &scope_id)?;
            let current = same_scope.first().map(|item| item.rev).unwrap_or(0);
            // B-03：草稿快照在确认事务内原子复核——status、作用域、来源集合、expectedRev、
            // 每条来源的 title+body 指纹都必须与草稿完全一致；manual 模式同样在事务内
            // 复核不存在待审草稿。mark_stale_if_changed 只是列表提示，不承担写入安全边界。
            if let Some(id) = draft_id {
                let Some(draft) = crate::distill_job::get_draft(&tx, id).ok().flatten() else {
                    return Ok(serde_json::json!({"status": "error", "error": "草稿不存在或已删除", "draftId": id}));
                };
                if draft.status != "pending" {
                    return Ok(serde_json::json!({"status": "error", "error": format!("草稿状态为 {}，过期草稿禁止直接提交，请重新整理", draft.status), "draftId": id}));
                }
                if draft.scope_kind != scope_kind || draft.scope_id != scope_id {
                    return Ok(serde_json::json!({"status": "error", "error": "草稿作用域与所选材料不一致", "draftId": id}));
                }
                let mut expected = draft.source_ids.clone();
                expected.sort();
                let mut actual = ids.to_vec();
                actual.sort();
                if expected != actual {
                    return Ok(serde_json::json!({"status": "error", "error": "提交的来源集合与草稿记录不一致，请重新核对草稿来源", "draftId": id}));
                }
                if let Some(expected) = expected_rev {
                    if expected != draft.expected_rev {
                        return Ok(serde_json::json!({
                            "status": "error",
                            "error": format!("请求的 expectedRev（{expected}）与草稿 expectedRev（{}）不一致：草稿已过期，禁止换新 rev 提交；请废弃后重新生成或从最新正文手工整理", draft.expected_rev),
                            "draftId": id,
                        }));
                    }
                }
                if current != draft.expected_rev {
                    return Ok(serde_json::json!({
                        "status": "conflict",
                        "currentRev": current,
                        "expectedRev": expected_rev,
                        "draftId": id,
                        "queued": false,
                        "conflicts": [],
                    }));
                }
                if draft.source_ids.is_empty() || draft.source_fingerprints.len() != draft.source_ids.len() {
                    return Ok(serde_json::json!({
                        "status": "error",
                        "error": "草稿缺少完整的来源指纹快照，无法证明快照未变化；请废弃后重新生成或手工整理",
                        "draftId": id,
                    }));
                }
                for (index, source_id) in draft.source_ids.iter().enumerate() {
                    let Some(item) = fresh_sources.iter().find(|item| &item.id == source_id) else {
                        return Ok(serde_json::json!({"status": "error", "error": "source changed", "inboxId": source_id}));
                    };
                    let actual_fp = format!("{}:{}", item.id, sha256_hex(&format!("{}\n{}", item.title, item.body)));
                    if draft.source_fingerprints[index] != actual_fp {
                        return Ok(serde_json::json!({
                            "status": "error",
                            "error": "来源内容与草稿快照不一致（标题或正文已变化）：请废弃草稿后重新生成",
                            "inboxId": source_id,
                            "draftId": id,
                        }));
                    }
                }
            } else {
                if let Ok(Some(pending)) = crate::distill_job::latest_draft(&tx, &scope_kind, &scope_id) {
                    if pending.status == "pending" {
                        return Ok(serde_json::json!({
                            "status": "error",
                            "error": "该作用域存在待审核草稿：请通过草稿入口审核提交，或先废弃草稿再手工整理",
                            "draftId": pending.id,
                        }));
                    }
                }
                if let Some(expected) = expected_rev {
                    if current != expected {
                        return Ok(serde_json::json!({"status": "conflict", "currentRev": current, "expectedRev": expected_rev, "queued": false, "conflicts": []}));
                    }
                } else if current > 0 {
                    return Ok(serde_json::json!({"status": "conflict", "currentRev": current, "queued": false, "conflicts": []}));
                }
            }
            let hash = sha256_hex(&format!("{title}\n{text}"));
            let now = now_iso();
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
            if let Some(draft) = draft_applies {
                let mut applied = draft;
                applied.status = "applied".into();
                applied.updated_at = crate::util::now_iso();
                if crate::distill_job::upsert_draft(&tx, &applied).is_err() {
                    return Ok(serde_json::json!({"status": "error", "error": "草稿状态更新失败"}));
                }
                let _ = store::audit(&tx, actor, "distill.applied", &applied.id);
            }
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
                // B-02：草稿提交遇到 rev 冲突时把草稿标记为过期，
                // 不给旧 draftId 换新 rev 重试的任何路径。
                if value["status"] == "conflict" {
                    if let Some(id) = draft_id {
                        let reason = format!(
                            "提交时正式记忆已推进到 rev {}，草稿过期；请废弃后重新生成或从最新正文手工整理",
                            value["currentRev"].as_i64().unwrap_or(0)
                        );
                        let _ = crate::distill_job::mark_draft_stale(conn, id, &reason);
                    }
                }
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
        let mut errors = 0;
        let config = crate::config::load_config();
        for (path, text, scope_id) in files {
            let text = text.trim();
            if text.len() < 8 {
                skipped += 1;
                continue;
            }
            let scope_kind = if scope_id.is_empty() { "personal" } else { "project" };
            let raw_hash = sha256_hex(text);
            // 稳定来源键策略（P0-03/P0-04/C-06）：canonical 绝对路径跨作用域查最近指纹比较内容；
            // 内容不变则无论归属如何变化都跳过（指纹保留原作用域）；内容变化才入队一个新版本。
            // UNC/WSL 风格/相对路径等无法证明唯一的键继续按作用域查重。
            let inbox_source_key = canonical_source_key(path).unwrap_or_else(|| path.clone());
            let global_key = source_key_is_global(path).then(|| inbox_source_key.clone());
            let fingerprint_hit = match &global_key {
                Some(key) => match store::latest_fingerprint_global(conn, source, key, crate::util::SCAN_RULES_VERSION) {
                    Ok(Some(fp)) if fp.content_hash == raw_hash => Some(fp),
                    Ok(_) => None,
                    Err(_) => {
                        skipped += 1;
                        errors += 1;
                        continue;
                    }
                },
                None => match store::latest_fingerprint(conn, source, path, scope_kind, scope_id, crate::util::SCAN_RULES_VERSION) {
                    Ok(Some(fp)) if fp.content_hash == raw_hash => Some(fp),
                    Ok(_) => None,
                    Err(_) => {
                        skipped += 1;
                        errors += 1;
                        continue;
                    }
                },
            };
            if let Some(fp) = fingerprint_hit {
                if store::touch_fingerprint(conn, &fp.id, "unchanged").is_err() {
                    errors += 1;
                } else {
                    skipped += 1;
                }
                continue;
            }
            // 单文件一个事务：材料入队/写入与指纹登记同生共死。
            // 指纹登记失败必须整体回滚，否则重扫会因缺少指纹而重复入队。
            let tx = match conn.unchecked_transaction() {
                Ok(tx) => tx,
                Err(_) => {
                    skipped += 1;
                    errors += 1;
                    continue;
                }
            };
            let result = Self::remember_tx(
                &tx,
                &config,
                text,
                Some(&clip_title(text, path)),
                source,
                Some(scope_kind),
                Some(scope_id),
                &format!("collector:{source}"),
                false,
                None,
                &inbox_source_key,
            );
            let status = result["status"].as_str().unwrap_or("error").to_string();
            // 指纹登记使用与查找一致的规范化来源键，保证跨轮次可命中。
            let fingerprint_key: String = global_key.clone().unwrap_or_else(|| path.clone());
            let fingerprint_ok = if status != "unchanged" {
                store::insert_fingerprint(
                    &tx,
                    source,
                    &fingerprint_key,
                    scope_kind,
                    scope_id,
                    &raw_hash,
                    crate::util::SCAN_RULES_VERSION,
                    &status,
                )
                .is_ok()
            } else {
                true
            };
            if !fingerprint_ok {
                // 材料与指纹必须一致：指纹失败则材料也不能留下，下一轮重扫重试。
                let _ = tx.rollback();
                skipped += 1;
                errors += 1;
                continue;
            }
            match status.as_str() {
                "stored" | "unchanged" | "queued" | "rejected" => {
                    if tx.commit().is_err() {
                        skipped += 1;
                        errors += 1;
                        continue;
                    }
                }
                _ => {
                    // 业务错误路径：remember_tx 未产生有效写入，回滚后跳过。
                    let _ = tx.rollback();
                    skipped += 1;
                    continue;
                }
            }
            if status == "unchanged" {
                skipped += 1;
            } else if status == "rejected" {
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
            errors,
        }
    }

    pub fn issue_key(conn: &Connection, name: &str) -> Result<serde_json::Value, String> {
        let mut raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = format!("ol_{}", hex::encode(raw));
        let id = new_id("key");
        let protected_token = crate::vault::protect_key(&id, &token)?;
        let record = crate::models::ApiKeyRecord {
            id,
            name: name.to_string(),
            token_hash: hash_token(&token),
            token_prefix: token.chars().take(8).collect(),
            protected_token: Some(protected_token),
            scopes: "global,project,personal".into(),
            tools: "memory.search,memory.remember,memory.forget,memory.list,memory.get".into(),
            created_at: now_iso(),
            last_used_at: None,
        };
        store::insert_key(conn, &record).map_err(|_| "无法保存 Agent 密钥".to_string())?;
        let _ = store::audit(conn, "admin", "key.create", &record.id);
        Ok(serde_json::json!({
            "id": record.id,
            "name": record.name,
            "token": token,
            "prefix": record.token_prefix
        }))
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

/// 来源路径形态：保守区分五类，避免归一化把无法证明同一性的不同文件合并成同一个键。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SourcePathKind {
    DriveAbsolute,
    DriveRelative,
    Unc,
    PosixAbsolute,
    Relative,
}

fn finish_key_parts(kind: SourcePathKind, rest: &str, prefix: &str) -> Option<(SourcePathKind, String)> {
    let mut segments: Vec<String> = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if segments.pop().is_none() {
                return None; // .. 越过根，无法证明规范形式
            }
            continue;
        }
        segments.push(part.to_string());
    }
    if segments.is_empty() {
        return None;
    }
    Some((kind, format!("{prefix}{}", segments.join("/"))))
}

/// 按 runtime 平台分类并规范化来源路径；无法保守规范化时返回 None。
fn classify_source_path(path: &str, windows_like: bool) -> Option<(SourcePathKind, String)> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 反斜杠只是 Windows 的分隔符；POSIX 文件名可含字面反斜杠，必须保留身份不得折叠。
    let folded = if windows_like { trimmed.replace('\\', "/") } else { trimmed.to_string() };
    if folded.starts_with('/') {
        let slash_run = folded.len() - folded.trim_start_matches('/').len();
        if slash_run >= 3 {
            return None; // 多余前导斜杠语义依平台而定，无法保守证明身份
        }
        let rest = &folded[slash_run..];
        // UNC 不折叠 // 前缀：保留身份，且永不与 POSIX 绝对路径合并
        if slash_run == 2 {
            return finish_key_parts(SourcePathKind::Unc, rest, "//");
        }
        return finish_key_parts(SourcePathKind::PosixAbsolute, rest, "/");
    }
    if windows_like {
        let bytes = folded.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let drive = (folded.as_bytes()[0] as char).to_ascii_lowercase();
            let rest = &folded[2..];
            if let Some(after) = rest.strip_prefix('/') {
                return finish_key_parts(SourcePathKind::DriveAbsolute, after, &format!("{drive}:/"));
            }
            return finish_key_parts(SourcePathKind::DriveRelative, rest, &format!("{drive}:"));
        }
    }
    finish_key_parts(SourcePathKind::Relative, &folded, "")
}

/// 平台明确的 canonical source-key（C-06，第五轮修复）：统一分隔符、消解 . / .. 片段，
/// 并保守区分五种形态——盘符绝对 / 盘符相对 / UNC / POSIX 绝对 / 相对，各自身份互不吞并：
/// - Windows：盘符绝对路径可证明全局唯一；POSIX 绝对路径（可能来自 WSL/挂载）保留身份
///   但不证明唯一；UNC 不折叠 `//` 前缀；盘符相对（C:foo）与相对路径按作用域去重。
/// - 非 Windows：POSIX 绝对路径（单根）保留根斜杠且可证明唯一；`//` 开头的 UNC 不折叠、
///   不全局；`C:/...` 只是首段恰为 `C:` 的相对路径，不做盘符解释（大小写也不折叠）。
/// 除盘符外不做大小写折叠：保守方向是不吞文件（大小写不同按不同文件处理）。
/// 无法保守规范化（空、纯根、.. 越根、3 个以上前导斜杠）时返回 None，调用方退回原值。
pub fn canonical_source_key(path: &str) -> Option<String> {
    canonical_source_key_for(path, cfg!(windows))
}

fn canonical_source_key_for(path: &str, windows_like: bool) -> Option<String> {
    classify_source_path(path, windows_like).map(|(_, key)| key)
}

/// 可证明跨作用域唯一的来源键：Windows 上的盘符绝对路径、非 Windows 上的 POSIX 绝对路径。
/// 只有这类键才允许跨作用域判断“同一文件”；相对名/短名/UNC/盘符相对/WSL 风格路径继续按
/// 作用域去重，避免共享文件名（如两个仓库各自的 AGENTS.md）跨项目吞材料（P0-04/C-06）。
pub fn source_key_is_global(source_key: &str) -> bool {
    source_key_is_global_for(source_key, cfg!(windows))
}

fn source_key_is_global_for(source_key: &str, windows_like: bool) -> bool {
    match classify_source_path(source_key, windows_like) {
        Some((SourcePathKind::DriveAbsolute, _)) if windows_like => true,
        Some((SourcePathKind::PosixAbsolute, _)) if !windows_like => true,
        _ => false,
    }
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
    use rusqlite::params;

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
        let result = MemoryService::confirm_sources(&conn, &config, &[first.clone(), second.clone()], "蒸馏后的整篇项目记忆", None, "admin", Some(0), None);
        assert_eq!(result["status"], "error");
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 2);
        assert!(store::list_active(&conn).expect("memories").is_empty());
        conn.execute_batch("DROP TRIGGER fail_inbox_delete").expect("drop trigger");
        let result = MemoryService::confirm_sources(&conn, &config, &[first, second], "蒸馏后的整篇项目记忆", None, "admin", Some(0), None);
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
        let result = MemoryService::confirm_sources(&conn, &config, &[source], "管理台编辑的整篇", None, "admin", Some(0), None);
        assert_eq!(result["status"], "conflict");
        assert_eq!(result["currentRev"], 1);
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
        let active = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert_eq!(active[0].body, "已有项目记忆");
    }

    /// 第五轮修复：确认事务内对每条 fresh 来源的标题与正文二次安全扫描——
    /// sensitivity 标记可能过期或被篡改（legacy/导入/被直接改库的 public 行），
    /// 内容自身必须通过扫描；任一命中整批拒绝、零写入（正式记忆/全部来源/审计不变）。
    #[test]
    fn confirm_sources_rescans_source_content_inside_the_transaction() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let insert = |id: &str, title: &str, body: &str, sensitivity: &str| crate::models::InboxRecord {
            id: id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            source: "cursor".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            sensitivity: sensitivity.to_string(),
            redacted: 0,
            queue_status: "proposed".into(),
            conflict_ids: vec![],
            created_at: crate::util::now_iso(),
            source_key: String::new(),
        };
        let clean = insert("in_clean", "干净采集材料", "正常的仓库约定说明，内容足够长。", "public");
        let tampered = insert(
            "in_tampered",
            "看似公开的合成材料",
            "说明\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-UNSAFE-MATERIAL-ONLY-FOR-TEST\n-----END PRIVATE KEY-----\n结尾",
            "public",
        );
        store::insert_inbox(&conn, clean.clone()).expect("insert clean");
        store::insert_inbox(&conn, tampered.clone()).expect("insert tampered");

        let rejected = MemoryService::confirm_sources(
            &conn,
            &config,
            &["in_clean".to_string(), "in_tampered".to_string()],
            "管理台干净整篇",
            None,
            "admin",
            Some(0),
            None,
        );
        assert_eq!(rejected["status"], "rejected");
        assert!(rejected["error"].as_str().expect("error").contains("安全复核"));
        let hits = rejected["hits"].as_array().expect("hits");
        assert!(hits.iter().any(|hit| hit["type"] == "private_key"));
        // 零写入：全部来源保留、无正式记忆、无 resolve/store 审计
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 2);
        assert!(store::list_active(&conn).expect("memories").is_empty());
        let audits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action IN ('memory.resolve','memory.store')",
                [],
                |row| row.get(0),
            )
            .expect("audit count");
        assert_eq!(audits, 0);

        // PII 哨兵同样整批拒绝
        let pii = insert("in_pii", "含联系方式的合成材料", "联系人 admin@example.com 的仓库说明，内容足够长。", "public");
        store::insert_inbox(&conn, pii).expect("insert pii");
        let pii_result = MemoryService::confirm_sources(&conn, &config, &["in_pii".to_string()], "另一篇干净整篇", None, "admin", Some(0), None);
        assert_eq!(pii_result["status"], "rejected");
        let pii_hits = pii_result["hits"].as_array().expect("pii hits");
        assert!(pii_hits.iter().any(|hit| hit["type"] == "email"));
        assert!(store::get_inbox(&conn, "in_pii").expect("inbox").is_some());

        // legacy / 备份导入路径的干净行（source_key 为空、sensitivity internal）不受影响，可正常确认
        let legacy = insert("in_legacy", "legacy 导入行", "旧版本导入的干净材料，内容足够长。", "internal");
        store::insert_inbox(&conn, legacy).expect("insert legacy");
        let ok = MemoryService::confirm_sources(
            &conn,
            &config,
            &["in_clean".to_string(), "in_legacy".to_string()],
            "重新整理的整篇项目记忆",
            None,
            "admin",
            Some(0),
            None,
        );
        assert_eq!(ok["status"], "stored");
        // 被拒的 tampered 行保持队列原状、正文原样
        let remaining = store::get_inbox(&conn, "in_tampered").expect("inbox").expect("row");
        assert_eq!(remaining.queue_status, "proposed");
        assert_eq!(remaining.body, tampered.body);
    }

    /// 第六轮修复回归：security.scan_enabled=false 时确认事务内的来源安全二次复核
    /// 仍必须执行——扫描开关只省掉入队替换劳动，不能让合成私钥来源绕过确认门。
    /// 覆盖 body/title 两个字段与混合安全/不安全来源，全事务零写入。
    #[test]
    fn confirm_sources_rescans_sources_even_when_scanning_is_disabled() {
        let conn = db::open_db(":memory:").expect("db");
        let mut config = config::default_config();
        config.security.scan_enabled = false;
        let insert = |id: &str, title: &str, body: &str| crate::models::InboxRecord {
            id: id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            source: "cursor".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            sensitivity: "public".into(),
            redacted: 0,
            queue_status: "proposed".into(),
            conflict_ids: vec![],
            created_at: crate::util::now_iso(),
            source_key: String::new(),
        };
        let clean = insert("in_clean", "干净采集材料", "正常的仓库约定说明，内容足够长。");
        let unsafe_body = insert(
            "in_unsafe_body",
            "正文不安全",
            "说明\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-UNSAFE-MATERIAL-ONLY-FOR-TEST\n-----END PRIVATE KEY-----\n结尾",
        );
        let unsafe_title = insert(
            "in_unsafe_title",
            "标题含私钥\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-UNSAFE-TITLE-ONLY-FOR-TEST\n-----END PRIVATE KEY-----",
            "正文本身干净且足够长。",
        );
        for item in [&clean, &unsafe_body, &unsafe_title] {
            store::insert_inbox(&conn, item.clone()).expect("insert");
        }
        for (label, ids) in [
            ("body", vec!["in_clean".to_string(), "in_unsafe_body".to_string()]),
            ("title", vec!["in_clean".to_string(), "in_unsafe_title".to_string()]),
            ("mixed", vec!["in_unsafe_body".to_string()]),
        ] {
            let result = MemoryService::confirm_sources(&conn, &config, &ids, "管理台干净整篇", None, "admin", Some(0), None);
            assert_eq!(result["status"], "rejected", "{label}");
            assert!(result["error"].as_str().expect("error").contains("安全复核"), "{label}");
        }
        // 全事务零写入：全部来源保留、无正式记忆、无 resolve/store 审计
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 3);
        assert!(store::list_active(&conn).expect("memories").is_empty());
        let audits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action IN ('memory.resolve','memory.store')",
                [],
                |row| row.get(0),
            )
            .expect("audit count");
        assert_eq!(audits, 0);

        // 同一开关下干净来源仍可正常确认（不是一刀切拒绝）
        let ok = MemoryService::confirm_sources(&conn, &config, std::slice::from_ref(&clean.id), "扫描关闭下的干净整篇", None, "admin", Some(0), None);
        assert_eq!(ok["status"], "stored");
    }

    #[test]
    fn repeated_confirm_after_success_does_not_revert_newer_revision() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue_source(&conn, &config, "采集材料准备确认");
        let first = MemoryService::confirm_sources(&conn, &config, std::slice::from_ref(&source), "第一版蒸馏", None, "admin", Some(0), None);
        assert_eq!(first["status"], "stored");
        // 另一个 Agent 已推进 rev
        let advanced = MemoryService::remember(&conn, &config, "第二版蒸馏", None, "mcp:agent", Some("project"), Some("OneLedger"), "agent", false, Some(1));
        assert_eq!(advanced["status"], "stored");
        // 重复提交同一来源：来源已删除，不应覆盖新版本
        let replay = MemoryService::confirm_sources(&conn, &config, &[source], "第一版蒸馏", None, "admin", Some(0), None);
        assert_eq!(replay["status"], "error");
        let active = store::list_active_by_scope(&conn, "project", "OneLedger").expect("scope");
        assert_eq!(active[0].body, "第二版蒸馏");
        assert_eq!(active[0].rev, 2);
    }

    #[test]
    fn fingerprint_failure_rolls_back_queued_material() {
        let conn = db::open_db(":memory:").expect("db");
        let files = vec![(
            "C:/work/OneLedger/NOTES.md".to_string(),
            "指纹登记失败时材料也不能留下".to_string(),
            "OneLedger".to_string(),
        )];
        conn.execute_batch(
            "CREATE TRIGGER fail_fingerprint BEFORE INSERT ON collect_fingerprints BEGIN SELECT RAISE(ABORT, 'failure'); END;",
        )
        .expect("trigger");
        let result = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(result.errors, 1);
        assert_eq!(result.queued, 0);
        assert!(store::list_inbox(&conn).expect("inbox").is_empty());
        assert!(store::list_active(&conn).expect("memories").is_empty());
        conn.execute_batch("DROP TRIGGER fail_fingerprint").expect("drop trigger");
        // 指纹恢复后重扫：正常入队一个新版本，不产生重复
        let retry = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(retry.queued, 1);
        assert_eq!(retry.errors, 0);
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
    }

    /// P0-04：两个仓库用同一模板（同标题同正文）时，各自都必须入队，第二个仓库不得被吞。
    #[test]
    fn identical_body_in_two_repos_queues_in_both() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let files_a = vec![("C:/work/RepoA/AGENTS.md".to_string(), "共同的仓库约定内容长文".to_string(), "RepoA".to_string())];
        let files_b = vec![("C:/work/RepoB/AGENTS.md".to_string(), "共同的仓库约定内容长文".to_string(), "RepoB".to_string())];
        let first = MemoryService::ingest_collected(&conn, "projects", &files_a);
        assert_eq!(first.queued, 1);
        let second = MemoryService::ingest_collected(&conn, "projects", &files_b);
        assert_eq!(second.queued, 1, "same body in another repo must queue independently");
        let items = store::list_inbox(&conn).expect("inbox");
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|item| item.scope_id == "RepoA"));
        assert!(items.iter().any(|item| item.scope_id == "RepoB"));
    }

    /// P0-04：非绝对来源键（无法证明跨作用域唯一）继续按作用域去重。
    #[test]
    fn relative_source_keys_stay_scope_scoped() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let files_a = vec![("AGENTS.md".to_string(), "相对来源键的约定内容长文".to_string(), "RepoA".to_string())];
        let first = MemoryService::ingest_collected(&conn, "projects", &files_a);
        assert_eq!(first.queued, 1);
        // 相同内容、相同相对键、不同作用域：必须再次入队
        let files_b = vec![("AGENTS.md".to_string(), "相对来源键的约定内容长文".to_string(), "RepoB".to_string())];
        let second = MemoryService::ingest_collected(&conn, "projects", &files_b);
        assert_eq!(second.queued, 1);
        // 同一作用域重扫：指纹命中跳过
        let again = MemoryService::ingest_collected(&conn, "projects", &files_a);
        assert_eq!(again.queued, 0);
        assert_eq!(again.skipped, 1);
    }

    /// P0-03：Windows 反斜杠路径与正斜杠路径是同一来源键（规范化）。
    #[test]
    fn backslash_and_slash_paths_share_fingerprint() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let slash = vec![("C:/work/Demo/NOTES.md".to_string(), "路径分隔符规范化内容长文".to_string(), "Demo".to_string())];
        let first = MemoryService::ingest_collected(&conn, "projects", &slash);
        assert_eq!(first.queued, 1);
        let backslash = vec![(r"C:\work\Demo\NOTES.md".to_string(), "路径分隔符规范化内容长文".to_string(), "Demo".to_string())];
        let second = MemoryService::ingest_collected(&conn, "projects", &backslash);
        assert_eq!(second.queued, 0, "same file with different separators must be deduplicated");
        assert_eq!(second.skipped, 1);
    }

    /// P0-01：作用域存在待审草稿时，未带 draft_id 的手工提交被拒绝；带 draft_id 且集合一致才放行。
    #[test]
    fn manual_resolve_is_blocked_while_pending_draft_exists() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue_source(&conn, &config, "有草稿待审核的手工场景");
        // B-03：草稿必须携带与来源一致的指纹快照，提交才可在事务内被验证
        let item = store::get_inbox(&conn, &source).expect("inbox").expect("row");
        let fingerprint = format!("{}:{}", item.id, crate::util::sha256_hex(&format!("{}\n{}", item.title, item.body)));
        let draft = crate::distill_job::DistillDraft {
            id: "dd_manual".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            title: "草稿".into(),
            body: "草稿正文".into(),
            source_ids: vec![source.clone()],
            source_fingerprints: vec![fingerprint],
            expected_rev: 0,
            provider: "stub".into(),
            model: "stub".into(),
            status: "pending".into(),
            stale_reason: String::new(),
            error: String::new(),
            attempts: 1,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        };
        crate::distill_job::upsert_draft(&conn, &draft).expect("draft");
        // 手工整理：被待审草稿阻断
        let blocked = MemoryService::confirm_sources(&conn, &config, &[source.clone()], "手工整篇", None, "admin", Some(0), None);
        assert_eq!(blocked["status"], "error");
        assert!(blocked["error"].as_str().unwrap_or("").contains("草稿"));
        // 带草稿 ID 且集合一致：放行并标记已应用
        let done = MemoryService::confirm_sources(&conn, &config, &[source], "草稿正文", Some("草稿"), "admin", Some(0), Some("dd_manual"));
        assert_eq!(done["status"], "stored");
        let applied = crate::distill_job::latest_draft(&conn, "project", "OneLedger").expect("draft").expect("row");
        assert_eq!(applied.status, "applied");
        // 应用后手工路径恢复
        let another = queue_source(&conn, &config, "草稿应用后的新手工场景");
        let manual = MemoryService::confirm_sources(&conn, &config, &[another], "手工整篇二", None, "admin", Some(1), None);
        assert_eq!(manual["status"], "stored");
    }

    /// P0-01：过期草稿禁止通过草稿入口提交。
    #[test]
    fn stale_draft_cannot_be_submitted_via_draft_id() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue_source(&conn, &config, "过期草稿禁止提交场景");
        let draft = crate::distill_job::DistillDraft {
            id: "dd_stale_submit".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            title: "过期草稿".into(),
            body: "过期草稿正文".into(),
            source_ids: vec![source.clone()],
            source_fingerprints: vec![],
            expected_rev: 0,
            provider: "stub".into(),
            model: "stub".into(),
            status: "stale".into(),
            stale_reason: "作用域已更新到 rev 1".into(),
            error: String::new(),
            attempts: 1,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        };
        crate::distill_job::upsert_draft(&conn, &draft).expect("draft");
        MemoryService::remember(&conn, &config, "先把正式记忆推到 rev 1", None, "mcp:x", Some("project"), Some("OneLedger"), "x", false, Some(0));
        let refused = MemoryService::confirm_sources(&conn, &config, &[source], "过期草稿正文", Some("过期草稿"), "admin", Some(1), Some("dd_stale_submit"));
        assert_eq!(refused["status"], "error");
        assert!(refused["error"].as_str().unwrap_or("").contains("过期"));
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
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
        let confirmed = MemoryService::confirm_sources(&conn, &config, &[inbox[0].id.clone()], "蒸馏整篇", None, "admin", Some(0), None);
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

    /// B-05：同仓库两个不同文件同文时各自入队，第二个文件不得被吞；重扫全部跳过。
    #[test]
    fn same_repo_identical_files_queue_separately() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let files = vec![
            ("C:/work/RepoA/AGENTS.md".to_string(), "同一份仓库约定内容长文".to_string(), "RepoA".to_string()),
            ("C:/work/RepoA/README.md".to_string(), "同一份仓库约定内容长文".to_string(), "RepoA".to_string()),
        ];
        let result = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(result.scanned_files, 2);
        assert_eq!(result.queued, 2);
        assert_eq!(result.skipped, 0);
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 2);
        // 各自登记指纹：重扫全部跳过
        let rescan = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(rescan.queued, 0);
        assert_eq!(rescan.skipped, 2);
        // 修改其中一个文件：恰好新增该文件的一个版本
        let changed = vec![("C:/work/RepoA/README.md".to_string(), "README 的新版本内容".to_string(), "RepoA".to_string())];
        let bump = MemoryService::ingest_collected(&conn, "projects", &changed);
        assert_eq!(bump.queued, 1);
    }

    /// C-06：canonical source-key 保守区分五种路径形态，不因归一化吞文件。
    /// 用显式平台参数同时覆盖 Windows 与 Linux 语义（第五轮修复：Linux 绝对路径保留根
    /// 斜杠、可全局；UNC 不折叠不全局；C:/ 前缀在 Linux 上只是相对路径、大小写不折叠）。
    #[test]
    fn canonical_source_key_is_platform_conservative() {
        use super::{canonical_source_key_for, source_key_is_global_for};
        // Windows：盘符大小写与分隔符归一；. / .. 消解
        assert_eq!(canonical_source_key_for(r"C:\Work\Demo\A.md", true).as_deref(), Some("c:/Work/Demo/A.md"));
        assert_eq!(canonical_source_key_for("c:/Work/Demo/../Demo/./A.md", true).as_deref(), Some("c:/Work/Demo/A.md"));
        // .. 越过根不可证明
        assert_eq!(canonical_source_key_for("C:/../A.md", true), None);
        // 大小写不折叠（保守：不吞可能不同的文件）
        assert_ne!(canonical_source_key_for("C:/Work/Demo/A.md", true), canonical_source_key_for("C:/work/demo/a.md", true));
        // 不同盘符永不相同
        assert_ne!(canonical_source_key_for("C:/x", true), canonical_source_key_for("D:/x", true));
        // 盘符相对路径（C:foo）：不全局，且与盘符绝对路径身份不同
        assert_eq!(canonical_source_key_for("C:work/A.md", true).as_deref(), Some("c:work/A.md"));
        assert_ne!(canonical_source_key_for("C:work/A.md", true), canonical_source_key_for("C:/work/A.md", true));
        assert!(!source_key_is_global_for("C:work/A.md", true));
        // Windows：POSIX 绝对路径保留身份但不全局（可能来自 WSL/挂载）
        assert_eq!(canonical_source_key_for("/home/user/AGENTS.md", true).as_deref(), Some("/home/user/AGENTS.md"));
        assert!(!source_key_is_global_for("/home/user/AGENTS.md", true));
        assert_ne!(canonical_source_key_for("/home/user/AGENTS.md", true), canonical_source_key_for("home/user/AGENTS.md", true));
        // Linux：POSIX 绝对路径保留根斜杠且可全局（第五轮语义回归）
        assert_eq!(canonical_source_key_for("/home/user/AGENTS.md", false).as_deref(), Some("/home/user/AGENTS.md"));
        assert!(source_key_is_global_for("/home/user/AGENTS.md", false));
        // Linux：相对路径与绝对路径身份不同，不得互相吞并；相对名不全局
        assert_eq!(canonical_source_key_for("home/user/AGENTS.md", false).as_deref(), Some("home/user/AGENTS.md"));
        assert_ne!(canonical_source_key_for("home/user/AGENTS.md", false), canonical_source_key_for("/home/user/AGENTS.md", false));
        assert!(!source_key_is_global_for("AGENTS.md", false));
        assert!(!source_key_is_global_for("AGENTS.md", true));
        // Linux：C:/ 前缀只是首段恰为 C: 的相对路径——不全局、大小写不折叠、不与 POSIX 绝对混淆
        assert_eq!(canonical_source_key_for("C:/work/AGENTS.md", false).as_deref(), Some("C:/work/AGENTS.md"));
        assert_ne!(canonical_source_key_for("C:/work/AGENTS.md", false), canonical_source_key_for("c:/work/AGENTS.md", false));
        assert_ne!(canonical_source_key_for("C:/work/AGENTS.md", false), canonical_source_key_for("/C:/work/AGENTS.md", false));
        assert!(!source_key_is_global_for("C:/work/AGENTS.md", false));
        // UNC 两端都不全局，且保留 // 前缀身份（不与 POSIX 绝对路径折叠合并）
        assert_eq!(canonical_source_key_for("//server/share/AGENTS.md", false).as_deref(), Some("//server/share/AGENTS.md"));
        assert_eq!(canonical_source_key_for(r"\\server\share\AGENTS.md", true).as_deref(), Some("//server/share/AGENTS.md"));
        assert_ne!(canonical_source_key_for("//server/share/AGENTS.md", false), canonical_source_key_for("/server/share/AGENTS.md", false));
        assert!(!source_key_is_global_for("//server/share/AGENTS.md", false));
        assert!(!source_key_is_global_for("//server/share/AGENTS.md", true));
        // 3 个以上前导斜杠语义依平台而定：保守返回 None
        assert_eq!(canonical_source_key_for("///server/share/A.md", false), None);
        // 反斜杠只是 Windows 分隔符（第六轮修复）：Linux 文件名可含字面反斜杠，
        // 绝对与相对形态都必须与同名正斜杠路径区分，不得折叠吞掉真实不同文件
        assert_eq!(canonical_source_key_for("/home/a\\b.md", false).as_deref(), Some("/home/a\\b.md"));
        assert_ne!(canonical_source_key_for("/home/a\\b.md", false), canonical_source_key_for("/home/a/b.md", false));
        assert!(source_key_is_global_for("/home/a\\b.md", false));
        assert_eq!(canonical_source_key_for("rel\\name.md", false).as_deref(), Some("rel\\name.md"));
        assert_ne!(canonical_source_key_for("rel\\name.md", false), canonical_source_key_for("rel/name.md", false));
        // Windows 上反斜杠仍是分隔符，与正斜杠同键（既有语义保持）
        assert_eq!(canonical_source_key_for(r"C:\Work\A.md", true), canonical_source_key_for("C:/Work/A.md", true));
        assert_eq!(canonical_source_key_for(r"relative\path.md", true).as_deref(), Some("relative/path.md"));
        // Windows：盘符绝对路径可全局
        assert!(source_key_is_global_for("C:/work/AGENTS.md", true));
        // runtime 入口与显式平台入口一致（宿主为 Windows）
        #[cfg(windows)]
        assert!(super::source_key_is_global("C:/work/AGENTS.md"));
        #[cfg(not(windows))]
        assert!(!super::source_key_is_global("C:/work/AGENTS.md"));
    }

    /// C-02：同毫秒时间戳并列时按 touched_seq 取最新——后创建的行先创建胜出不了被触碰的行。
    #[test]
    fn fingerprint_latest_ordering_uses_monotonic_seq() {
        let conn = db::open_db(":memory:").expect("db");
        // 同键、同规则版本、两个不同内容 hash，同一毫秒内登记（A 先、B 后）
        store::insert_fingerprint(&conn, "projects", "C:/w/A.md", "project", "RepoA", "hash_A", crate::util::SCAN_RULES_VERSION, "queued").expect("fp A");
        store::insert_fingerprint(&conn, "projects", "C:/w/A.md", "project", "RepoA", "hash_B", crate::util::SCAN_RULES_VERSION, "queued").expect("fp B");
        // 触碰较早创建的 A：单调序号让 A 成为最新（旧实现只看 last_seen_at 毫秒并列时结果不确定）
        let row_a: String = {
            let mut stmt = conn.prepare("SELECT id FROM collect_fingerprints WHERE content_hash = 'hash_A'").expect("stmt");
            let mut rows = stmt.query_map([], |row| row.get::<_, String>(0)).expect("map");
            rows.next().expect("row").expect("id")
        };
        store::touch_fingerprint(&conn, &row_a, "unchanged").expect("touch A");
        let latest = store::latest_fingerprint_global(&conn, "projects", "C:/w/A.md", crate::util::SCAN_RULES_VERSION).expect("lookup").expect("row");
        assert_eq!(latest.content_hash, "hash_A", "touched A must win over later-created B despite identical timestamps");
    }

    /// B-03：草稿快照在确认事务内原子复核（Rust 侧镜像）。
    #[test]
    fn draft_snapshot_is_verified_inside_the_confirm_transaction() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let queued = MemoryService::remember(&conn, &config, "草稿来源原始内容，内容足够长", None, "cursor", Some("project"), Some("OneLedger"), "collector:cursor", false, None);
        assert_eq!(queued["status"], "queued");
        let inbox_id = queued["inboxId"].as_str().unwrap().to_string();
        let source = store::get_inbox(&conn, &inbox_id).expect("inbox").expect("row");
        let fingerprint = format!("{}:{}", source.id, crate::util::sha256_hex(&format!("{}\n{}", source.title, source.body)));
        let draft = |expected_rev: i64, id: &str| crate::distill_job::DistillDraft {
            id: format!("dd_b03_{id}"),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            title: "草稿标题".into(),
            body: "草稿正文".into(),
            source_ids: vec![inbox_id.clone()],
            source_fingerprints: vec![fingerprint.clone()],
            expected_rev,
            provider: "stub".into(),
            model: "stub".into(),
            status: "pending".into(),
            stale_reason: String::new(),
            error: String::new(),
            attempts: 1,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        };

        // 场景 1：来源正文被改但 ID 不变 → 指纹不符，拒绝且来源保留
        let d1 = draft(0, "tamper");
        crate::distill_job::upsert_draft(&conn, &d1).expect("draft");
        conn.execute("UPDATE inbox SET body = body || '（被外部修改）' WHERE id = ?1", params![inbox_id]).expect("tamper");
        let tampered = MemoryService::confirm_sources(&conn, &config, &[inbox_id.clone()], "草稿正文", Some("草稿标题"), "admin", Some(0), Some(&d1.id));
        assert_eq!(tampered["status"], "error");
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
        conn.execute("UPDATE inbox SET body = ?1 WHERE id = ?2", params![source.body, inbox_id]).expect("restore");

        // 场景 2：草稿以 rev 0 生成、服务器 rev 1；请求带 expectedRev=1 与旧 draftId 也拒绝
        let advanced = MemoryService::remember(&conn, &config, "他人推进的 rev 1", None, "mcp:x", Some("project"), Some("OneLedger"), "x", false, Some(0));
        assert_eq!(advanced["status"], "stored");
        let d2 = draft(0, "revbump");
        crate::distill_job::upsert_draft(&conn, &d2).expect("draft");
        let stale = MemoryService::confirm_sources(&conn, &config, &[inbox_id.clone()], "草稿正文", Some("草稿标题"), "admin", Some(1), Some(&d2.id));
        assert_eq!(stale["status"], "error");
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);

        // 场景 3：请求 rev 与草稿一致、但当前 rev 已越过草稿 expectedRev → conflict + 草稿标 stale
        let d3 = draft(0, "conflict");
        crate::distill_job::upsert_draft(&conn, &d3).expect("draft");
        let conflict = MemoryService::confirm_sources(&conn, &config, &[inbox_id.clone()], "草稿正文", Some("草稿标题"), "admin", Some(0), Some(&d3.id));
        assert_eq!(conflict["status"], "conflict");
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
        let marked = crate::distill_job::get_draft(&conn, &d3.id).expect("read").expect("draft");
        assert_eq!(marked.status, "stale", "conflicting draft submit must mark the draft stale");

        // 场景 4：不过任务页直接请求 resolve——合法未过期草稿恰好提交一次，重复确认被拒
        let d4 = draft(1, "fresh");
        crate::distill_job::upsert_draft(&conn, &d4).expect("draft");
        let done = MemoryService::confirm_sources(&conn, &config, &[inbox_id.clone()], "草稿正文", Some("草稿标题"), "admin", Some(1), Some(&d4.id));
        assert_eq!(done["status"], "stored");
        assert!(store::list_inbox(&conn).expect("inbox").is_empty());
        let applied = crate::distill_job::get_draft(&conn, &d4.id).expect("read").expect("draft");
        assert_eq!(applied.status, "applied");
        let replay = MemoryService::confirm_sources(&conn, &config, &[inbox_id], "草稿正文", Some("草稿标题"), "admin", Some(1), Some(&d4.id));
        assert_eq!(replay["status"], "error");
    }

    /// C-05：人工确认批量上限——101 条零写入拒绝，100 条边界成功。
    #[test]
    fn confirm_sources_enforces_batch_limit() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let now = crate::util::now_iso();
        let mut ids: Vec<String> = Vec::new();
        for index in 0..101 {
            let id = format!("in_c{index:03}");
            conn.execute(
                "INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids)
                 VALUES (?1, ?2, ?3, 'cursor', 'project', 'OneLedger', 'public', 0, ?4, 'proposed', '')",
                params![id, format!("批量材料 {index}"), format!("批量验收材料 {index}：内容足够长以通过最短限制要求。"), now],
            )
            .expect("insert");
            ids.push(id);
        }
        let over = MemoryService::confirm_sources(&conn, &config, &ids, "超限的整篇", None, "admin", Some(0), None);
        assert_eq!(over["status"], "error");
        assert!(over["error"].as_str().unwrap_or("").contains("100"));
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 101);
        assert!(store::list_active(&conn).expect("active").is_empty());
        let done = MemoryService::confirm_sources(&conn, &config, &ids[..100], "边界整篇", None, "admin", Some(0), None);
        assert_eq!(done["status"], "stored");
        assert_eq!(store::list_inbox(&conn).expect("inbox").len(), 1);
    }
}
