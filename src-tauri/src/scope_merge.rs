//! 作用域归并：把历史路径型 scopeId 的 proposed 材料人工归并到正确的仓库名。
//! 预览（只读，绑定本批精确 ID 集合的 digest）→ 确认（单事务重校验，最多 MERGE_BATCH_LIMIT
//! 条为一批，全成全败）→ 条件撤销（只针对该操作 item 表记录的精确 ID，任一条已离开目标
//! 作用域则整体拒绝）。归并/撤销只改 inbox 作用域，绝不移动或删除 collect_fingerprints；
//! 正式记忆、已拒收材料与已保存凭据不随归并移动。

use crate::store::{self, ScopeMergeOperation};
use crate::util::{new_id, now_iso, sha256_hex, MERGE_BATCH_LIMIT};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

/// 目标作用域必须是仓库名：非空、不含路径分隔符/盘符迹象/点片段。
pub fn is_repository_scope_id(scope_id: &str) -> bool {
    let id = scope_id.trim();
    !id.is_empty() && id.chars().count() <= 120 && !store::scope_id_looks_like_path(id)
}

fn pending_count(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM inbox WHERE queue_status = 'proposed' AND scope_kind = ?1 AND scope_id = ?2",
        params![kind, id],
        |row| row.get(0),
    )
}

/// 全部来源分布（确认记录用，无截断；分布总和等于本批移动数）。
/// 使用 batch_ids 临时表圈定本批；调用方负责临时表内容一致。
fn batch_breakdown(conn: &Connection, batch: &[String]) -> rusqlite::Result<Map<String, Value>> {
    let mut breakdown = Map::new();
    if batch.is_empty() {
        return Ok(breakdown);
    }
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS merge_batch_ids (inbox_id TEXT PRIMARY KEY)", [])?;
    conn.execute("DELETE FROM merge_batch_ids", [])?;
    {
        let mut stmt = conn.prepare("INSERT OR IGNORE INTO merge_batch_ids (inbox_id) VALUES (?1)")?;
        for inbox_id in batch {
            stmt.execute(params![inbox_id])?;
        }
    }
    let mut stmt = conn.prepare(
        "SELECT source, COUNT(*) FROM inbox
         WHERE id IN (SELECT inbox_id FROM merge_batch_ids)
         GROUP BY source ORDER BY COUNT(*) DESC, source ASC",
    )?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (source, count) in rows {
        breakdown.insert(source, json!(count));
    }
    Ok(breakdown)
}

/// 预览展示用 top20 来源分布，其余合并为 otherCount/otherKinds（M-02）。
fn breakdown_top20(breakdown: &Map<String, Value>) -> (Vec<Value>, i64, i64) {
    let total: i64 = breakdown.values().filter_map(|v| v.as_i64()).sum();
    let entries: Vec<(&String, &Value)> = breakdown.iter().collect();
    let top = entries
        .iter()
        .take(20)
        .map(|(source, count)| json!({ "source": source, "count": count }))
        .collect::<Vec<_>>();
    let top_sum: i64 = top.iter().filter_map(|item| item["count"].as_i64()).sum();
    (top, total - top_sum, (entries.len().saturating_sub(20)) as i64)
}

/// 本批 ID：按稳定 (created_at, id) 次序取前 MERGE_BATCH_LIMIT 条 proposed 材料。
/// 返回 (本批 [(id, created_at)], 来源总 pending, 来源剩余未入批数量)。
fn next_batch(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<(Vec<(String, String)>, i64, i64)> {
    let mut stmt = conn.prepare(
        "SELECT id, created_at FROM inbox
         WHERE queue_status = 'proposed' AND scope_kind = ?1 AND scope_id = ?2
         ORDER BY created_at ASC, id ASC LIMIT ?3",
    )?;
    let batch = stmt
        .query_map(params![kind, id, MERGE_BATCH_LIMIT], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total = pending_count(conn, kind, id)?;
    let batch_len = batch.len() as i64;
    Ok((batch, total, total - batch_len))
}

fn pending_draft_rows(conn: &Connection, from_id: &str, to_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT scope_id, id, status, updated_at, stale_reason FROM distill_drafts
         WHERE status = 'pending' AND scope_kind = 'project' AND (scope_id = ?1 OR scope_id = ?2)
         ORDER BY updated_at DESC LIMIT 10",
    )?;
    let rows = stmt
        .query_map(params![from_id, to_id], |row| {
            Ok(json!({
                "scopeId": row.get::<_, String>(0)?,
                "id": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "updatedAt": row.get::<_, String>(3)?,
                "staleReason": row.get::<_, String>(4)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// 归并前状态摘要：绑定本批精确 ID 集合与来源/目标现状（P0-05/C-01）。
/// v3 相比 v2 增加来源作用域总 pending 数：来源在本批之外新增/移走一条时，
/// 本批 ID 不变但总数变化，旧预览同样失效。只流式取本批（≤1000 条）的 ID，不把整个作用域装进内存。
fn state_digest(
    conn: &Connection,
    from_kind: &str,
    from_id: &str,
    to_id: &str,
) -> rusqlite::Result<String> {
    let (batch, pending, _) = next_batch(conn, from_kind, from_id)?;
    let to_pending = pending_count(conn, "project", to_id)?;
    let to_memory: (String, i64) = conn
        .query_row(
            "SELECT id, rev FROM memories WHERE status = 'active' AND scope_kind = 'project' AND scope_id = ?1
             ORDER BY updated_at DESC LIMIT 1",
            params![to_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .unwrap_or((String::new(), 0));
    let drafts = pending_draft_rows(conn, from_id, to_id)?;
    let mut payload = String::new();
    payload.push_str("oneledger-merge-digest-v3\n");
    payload.push_str(&format!("from:{from_kind}\u{0}{from_id}\n"));
    payload.push_str(&format!("to:{to_id}\n"));
    payload.push_str(&format!("fromPending:{pending}\n"));
    payload.push_str(&format!("batch:{}\n", batch.len()));
    for (inbox_id, _) in &batch {
        payload.push_str(inbox_id);
        payload.push('\n');
    }
    payload.push_str(&format!("toPending:{to_pending}\n"));
    payload.push_str(&format!("toMemory:{}:{}\n", to_memory.0, to_memory.1));
    payload.push_str("drafts:");
    for draft in &drafts {
        payload.push_str(&format!("{},", draft["id"].as_str().unwrap_or("")));
    }
    Ok(sha256_hex(&payload))
}

/// 归并预览：只读。返回本批数量与剩余、来源分布、目标现状、草稿阻断、本批样本与提交时要带的 digest。
pub fn preview(conn: &Connection, from_kind: &str, from_id: &str, to_id: &str) -> Result<Value, String> {
    let to_id = to_id.trim();
    if from_kind != "project" {
        return Err("只支持归并 project 作用域的材料".into());
    }
    if from_id.trim().is_empty() {
        return Err("来源作用域不能为空".into());
    }
    if !is_repository_scope_id(to_id) {
        return Err("目标作用域必须是仓库名：不能为空，也不能含路径分隔符、盘符或 . / .. 片段".into());
    }
    if from_id == to_id {
        return Err("来源与目标作用域相同，无需归并".into());
    }
    let pending = pending_count(conn, from_kind, from_id).map_err(|e| e.to_string())?;
    if pending == 0 {
        return Err("来源作用域没有待蒸馏材料".into());
    }
    let (batch, pending, remaining) = next_batch(conn, from_kind, from_id).map_err(|e| e.to_string())?;
    let batch_ids: Vec<String> = batch.iter().map(|(id, _)| id.clone()).collect();
    let breakdown = batch_breakdown(conn, &batch_ids).map_err(|e| e.to_string())?;
    let (source_breakdown, other_count, other_kinds) = breakdown_top20(&breakdown);
    // B-07：本批全部条目的脱敏元数据（≤1000 条），供管理员分页/筛选逐条核对归属，
    // 只勾选可证明属于目标仓库的 ID；确认只移动显式选中的子集。
    let batch_rows = store::inbox_by_ids(conn, &batch_ids).map_err(|e| e.to_string())?;
    let batch_items: Vec<Value> = batch_rows
        .iter()
        .map(|item| {
            json!({
                "id": item.id,
                "title": item.title,
                "source": item.source,
                "createdAt": item.created_at,
                "sensitivity": item.sensitivity,
            })
        })
        .collect();
    let to_pending = pending_count(conn, "project", to_id).map_err(|e| e.to_string())?;
    let to_memory: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT id, rev, updated_at FROM memories
             WHERE status = 'active' AND scope_kind = 'project' AND scope_id = ?1
             ORDER BY updated_at DESC LIMIT 1",
            params![to_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let drafts = pending_draft_rows(conn, from_id, to_id).map_err(|e| e.to_string())?;
    let digest = state_digest(conn, from_kind, from_id, to_id).map_err(|e| e.to_string())?;
    let mut blocked = Vec::new();
    if !drafts.is_empty() {
        blocked.push("来源或目标作用域存在待审核草稿；请先废弃或处理该草稿，避免旧草稿把材料写回错误作用域。".to_string());
    }
    Ok(json!({
        "status": "ok",
        "fromScopeKind": from_kind,
        "fromScopeId": from_id,
        "toScopeId": to_id,
        "pending": pending,
        "batch": batch.len(),
        "remaining": remaining,
        "batchLimit": MERGE_BATCH_LIMIT,
        "sourceBreakdown": source_breakdown,
        "otherCount": other_count,
        "otherKinds": other_kinds,
        "batchItems": batch_items,
        "toPending": to_pending,
        "toMemory": to_memory.map(|(id, rev, updated_at)| json!({ "id": id, "rev": rev, "updatedAt": updated_at })),
        "drafts": drafts,
        "blocked": blocked,
        "digest": digest,
    }))
}

fn load_batch_ids(conn: &Connection, from_kind: &str, from_id: &str) -> rusqlite::Result<Vec<String>> {
    let (batch, _, _) = next_batch(conn, from_kind, from_id)?;
    let batch_ids: Vec<String> = batch.into_iter().map(|(id, _)| id).collect();
    let breakdown_ready = batch_breakdown(conn, &batch_ids)?;
    debug_assert!(!breakdown_ready.is_empty() || batch_ids.is_empty());
    Ok(batch_ids)
}

/// 确认归并一批（≤ MERGE_BATCH_LIMIT 条）中管理员显式勾选的精确 ID 子集。
/// B-07：只移动已审核选中的 ID——请求必须带非空、无重复、且全部落在本批（digest 绑定的
/// 精确 ID 集合）内的 ids；单事务内重校验 digest、目标合法性、每条选中材料仍处于预期
/// 作用域与 proposed 状态；不一致返回 conflict 与新预览，不做部分归并。
pub fn confirm(conn: &Connection, from_kind: &str, from_id: &str, to_id: &str, digest: &str, selected_ids: &[String], actor: &str) -> Value {
    let to_id = to_id.trim();
    if let Err(reason) = basic_checks(from_kind, from_id, to_id) {
        return json!({ "status": "error", "error": reason });
    }
    if digest.is_empty() {
        return json!({ "status": "error", "error": "缺少预览摘要 digest，请先预览" });
    }
    let mut unique = selected_ids.to_vec();
    unique.sort();
    unique.dedup();
    if unique.len() != selected_ids.len() {
        return json!({ "status": "error", "error": "勾选的材料 ID 有重复，请重新核对" });
    }
    if selected_ids.len() > MERGE_BATCH_LIMIT as usize {
        return json!({ "status": "error", "error": format!("一次最多归并 {MERGE_BATCH_LIMIT} 条") });
    }
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(error) => return json!({ "status": "error", "error": format!("事务失败：{error}") }),
    };
    let outcome = {
        let t: &Connection = &tx;
        (|| -> rusqlite::Result<Value> {
        let current_digest = state_digest(t, from_kind, from_id, to_id)?;
        if current_digest != digest {
            let fresh = preview(t, from_kind, from_id, to_id).unwrap_or(Value::Null);
            return Ok(json!({ "status": "conflict", "error": "作用域状态已变化，请核对新预览后重试", "preview": fresh }));
        }
        let drafts = pending_draft_rows(t, from_id, to_id)?;
        if !drafts.is_empty() {
            return Ok(json!({ "status": "blocked", "error": "来源或目标作用域存在待审核草稿，先废弃或处理后再归并", "drafts": drafts }));
        }
        let batch_ids = load_batch_ids(t, from_kind, from_id)?;
        if batch_ids.is_empty() {
            return Ok(json!({ "status": "conflict", "error": "来源作用域已没有待蒸馏材料" }));
        }
        if selected_ids.is_empty() {
            return Ok(json!({ "status": "error", "error": "请先在预览清单中勾选经核对属于目标仓库的材料；默认不选择，不勾选不能归并" }));
        }
        let batch_set: std::collections::HashSet<&String> = batch_ids.iter().collect();
        let missing: Vec<&String> = selected_ids.iter().filter(|id| !batch_set.contains(id)).collect();
        if !missing.is_empty() {
            return Ok(json!({ "status": "conflict", "error": format!("有 {} 条勾选材料不在当前批次中（预览后批次已变化），请重新预览", missing.len()), "preview": preview(t, from_kind, from_id, to_id).unwrap_or(Value::Null) }));
        }
        // 本批（重算）分布已由 load_batch_ids 装入临时表；这里改按显式勾选子集统计来源分布
        t.execute("DELETE FROM merge_batch_ids", [])?;
        {
            let mut stmt = t.prepare("INSERT OR IGNORE INTO merge_batch_ids (inbox_id) VALUES (?1)")?;
            for inbox_id in selected_ids {
                stmt.execute(params![inbox_id])?;
            }
        }
        let breakdown = {
            let mut stmt = t.prepare(
                "SELECT source, COUNT(*) FROM inbox
                 WHERE id IN (SELECT inbox_id FROM merge_batch_ids)
                 GROUP BY source ORDER BY COUNT(*) DESC, source ASC",
            )?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut map = Map::new();
            for (source, count) in rows {
                map.insert(source, json!(count));
            }
            map
        };
        let moved = t.execute(
            "UPDATE inbox SET scope_kind = ?3, scope_id = ?4
             WHERE id IN (SELECT inbox_id FROM merge_batch_ids) AND queue_status = 'proposed'
               AND scope_kind = ?1 AND scope_id = ?2",
            params![from_kind, from_id, "project", to_id],
        )? as i64;
        if moved != selected_ids.len() as i64 {
            return Ok(json!({ "status": "conflict", "error": "作用域状态在归并过程中发生变化，已整体回滚" }));
        }
        let operation = ScopeMergeOperation {
            id: new_id("sm"),
            from_scope_kind: from_kind.into(),
            from_scope_id: from_id.into(),
            to_scope_kind: "project".into(),
            to_scope_id: to_id.into(),
            moved_ids: selected_ids.to_vec(),
            moved_count: moved,
            source_breakdown: Value::Object(breakdown),
            status: "applied".into(),
            created_at: now_iso(),
            reverted_at: None,
        };
        store::insert_merge_operation(t, &operation)?;
        store::audit(
            t,
            actor,
            "scope.merge",
            &format!(
                "{}:{} -> {}:{} moved={} selected={} batch={}",
                operation.from_scope_kind, operation.from_scope_id, operation.to_scope_kind, operation.to_scope_id, operation.moved_count, selected_ids.len(), batch_ids.len()
            ),
        )?;
        let remaining = pending_count(t, from_kind, from_id)?;
        Ok(json!({
            "status": "applied",
            "operationId": operation.id,
            "moved": operation.moved_count,
            "toScopeId": operation.to_scope_id,
            "remaining": remaining,
        }))
        })()
    };
    match outcome {
        Ok(value) if value["status"] == "applied" => match tx.commit() {
            Ok(()) => value,
            Err(error) => json!({ "status": "error", "error": format!("提交失败：{error}") }),
        },
        Ok(value) => {
            let _ = tx.rollback();
            value
        }
        Err(error) => {
            let _ = tx.rollback();
            json!({ "status": "error", "error": format!("归并失败：{error}") })
        }
    }
}

fn basic_checks(from_kind: &str, from_id: &str, to_id: &str) -> Result<(), String> {
    if from_kind != "project" {
        return Err("只支持归并 project 作用域的材料".into());
    }
    if from_id.trim().is_empty() {
        return Err("来源作用域不能为空".into());
    }
    if !is_repository_scope_id(to_id) {
        return Err("目标作用域必须是仓库名：不能为空，也不能含路径分隔符、盘符或 . / .. 片段".into());
    }
    if from_id == to_id {
        return Err("来源与目标作用域相同，无需归并".into());
    }
    Ok(())
}

/// 撤销一次归并：只把该操作 item 表记录、且仍处于目标作用域 proposed 状态的材料移回原作用域。
/// 任一条已被蒸馏、删除或再次移动，则整体拒绝；重复撤销幂等返回已撤销。
/// 只改 inbox 作用域，不移动或删除任何采集指纹。
pub fn revert(conn: &Connection, operation_id: &str, actor: &str) -> Value {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(error) => return json!({ "status": "error", "error": format!("事务失败：{error}") }),
    };
    let outcome = {
        let t: &Connection = &tx;
        (|| -> rusqlite::Result<Value> {
        let Some(operation) = store::load_merge_operation(t, operation_id)? else {
            return Ok(json!({ "status": "error", "error": "操作记录不存在" }));
        };
        if operation.status == "reverted" {
            return Ok(json!({ "status": "already-reverted", "operationId": operation.id, "reverted": 0 }));
        }
        if operation.status != "applied" {
            return Ok(json!({ "status": "error", "error": format!("操作状态为 {}，无法撤销", operation.status) }));
        }
        let batch = operation.batch_ids();
        if batch.is_empty() {
            return Ok(json!({ "status": "error", "error": "操作缺少批次明细（scope_merge_operation_items），无法撤销" }));
        }
        // 用 SQL JOIN 直接核查该批，任何一条已离队则整批拒绝。
        let still_movable: i64 = t.query_row(
            "SELECT COUNT(*) FROM inbox i JOIN scope_merge_operation_items s
               ON i.id = s.inbox_id AND s.operation_id = ?1
             WHERE i.queue_status = 'proposed' AND i.scope_kind = ?2 AND i.scope_id = ?3",
            params![operation.id, operation.to_scope_kind, operation.to_scope_id],
            |row| row.get(0),
        )?;
        if still_movable != batch.len() as i64 {
            return Ok(json!({
                "status": "conflict",
                "error": format!(
                    "有 {} 条材料已不在目标作用域的待处理状态（可能已被蒸馏、删除或再次移动），不能自动撤销；已写入正式记忆的内容不受影响",
                    batch.len() as i64 - still_movable
                ),
                "movedCount": batch.len() as i64,
                "stillMovable": still_movable,
            }));
        }
        let moved_back = t.execute(
            "UPDATE inbox SET scope_kind = ?3, scope_id = ?4
             WHERE id IN (SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = ?5)
               AND queue_status = 'proposed' AND scope_kind = ?1 AND scope_id = ?2",
            params![operation.to_scope_kind, operation.to_scope_id, operation.from_scope_kind, operation.from_scope_id, operation.id],
        )? as i64;
        if moved_back != batch.len() as i64 {
            return Ok(json!({ "status": "conflict", "error": "撤销过程中状态变化，已整体回滚" }));
        }
        let marked = t.execute(
            "UPDATE scope_merge_operations SET status = 'reverted', reverted_at = ?2 WHERE id = ?1 AND status = 'applied'",
            params![operation.id, now_iso()],
        )?;
        if marked != 1 {
            return Ok(json!({ "status": "conflict", "error": "操作状态已变化，已整体回滚" }));
        }
        store::audit(
            t,
            actor,
            "scope.merge.revert",
            &format!(
                "{} moved={} back to {}:{}",
                operation.id, moved_back, operation.from_scope_kind, operation.from_scope_id
            ),
        )?;
        Ok(json!({ "status": "reverted", "operationId": operation.id, "reverted": moved_back }))
        })()
    };
    match outcome {
        Ok(value) if value["status"] == "reverted" => match tx.commit() {
            Ok(()) => value,
            Err(error) => json!({ "status": "error", "error": format!("提交失败：{error}") }),
        },
        Ok(value) => {
            let _ = tx.rollback();
            value
        }
        Err(error) => {
            let _ = tx.rollback();
            json!({ "status": "error", "error": format!("撤销失败：{error}") })
        }
    }
}

/// 操作记录列表（分页，只含概要字段），供管理台展示与撤销。
pub fn list_operations(conn: &Connection, limit: i64, offset: i64) -> Value {
    match store::list_merge_operation_summaries(conn, limit, offset) {
        Ok((rows, total)) => {
            let operations: Vec<Value> = rows
                .iter()
                .map(|op| {
                    json!({
                        "id": op.id,
                        "fromScopeKind": op.from_scope_kind,
                        "fromScopeId": op.from_scope_id,
                        "toScopeKind": op.to_scope_kind,
                        "toScopeId": op.to_scope_id,
                        "movedCount": op.moved_count,
                        "sourceBreakdown": op.source_breakdown,
                        "status": op.status,
                        "createdAt": op.created_at,
                        "revertedAt": op.reverted_at,
                    })
                })
                .collect();
            json!({ "operations": operations, "total": total })
        }
        Err(error) => json!({ "error": format!("读取操作记录失败：{error}") }),
    }
}

/// 只读检测报告：列出曾经执行过归并的操作与其来源/目标作用域当时的指纹数量，
/// 供 v10 期间错误归并（指纹曾被搬移/删除）后的管理员人工复核。
/// 已删除的指纹无法凭操作记录恢复，报告只给出核对线索，不做任何写入。
pub fn fingerprint_damage_report(conn: &Connection) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_count, status, created_at, reverted_at
             FROM scope_merge_operations ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let from_kind: String = row.get(1)?;
            let from_id: String = row.get(2)?;
            let to_kind: String = row.get(3)?;
            let to_id: String = row.get(4)?;
            let fp_from: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM collect_fingerprints WHERE scope_kind = ?1 AND scope_id = ?2",
                    params![from_kind, from_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let fp_to: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM collect_fingerprints WHERE scope_kind = ?1 AND scope_id = ?2",
                    params![to_kind, to_id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(json!({
                "operationId": row.get::<_, String>(0)?,
                "fromScope": format!("{from_kind}:{from_id}"),
                "toScope": format!("{to_kind}:{to_id}"),
                "movedCount": row.get::<_, i64>(5)?,
                "status": row.get::<_, String>(6)?,
                "createdAt": row.get::<_, String>(7)?,
                "revertedAt": row.get::<_, Option<String>>(8)?,
                "fingerprintsNowInFromScope": fp_from,
                "fingerprintsNowInToScope": fp_to,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "status": "report",
        "note": "v10 期间的归并曾搬移/删除 collect_fingerprints 行；被删除的指纹无法凭操作记录恢复。以下操作涉及的来源/目标作用域指纹需人工核对：确认来源文件是否被错误去重（丢失指纹会导致重扫重复入队，可重新采集；重复指纹会掩盖新版本，需比对 content_hash）。执行任何修复前必须先完成全量备份。",
        "operations": rows,
    }))
}

#[cfg(test)]
mod tests {
    use super::{confirm, fingerprint_damage_report, is_repository_scope_id, list_operations, pending_count, preview, revert};
    use crate::config;
    use crate::db;
    use crate::service::MemoryService;
    use crate::store;
    use rusqlite::params;

    /// B-07：从预览取本批全部 ID（测试里“全选本批”等价于 UI 逐条勾选后提交）。
    /// 预览失败（如来源已清空）时返回空集——此时旧 digest 会在 confirm 内命中 conflict。
    fn preview_batch_ids(conn: &rusqlite::Connection, from_kind: &str, from_id: &str, to_id: &str) -> Vec<String> {
        let Ok(view) = preview(conn, from_kind, from_id, to_id) else {
            return Vec::new();
        };
        view["batchItems"]
            .as_array()
            .map(|items| items.iter().filter_map(|item| item["id"].as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    fn confirm_batch(conn: &rusqlite::Connection, from_kind: &str, from_id: &str, to_id: &str, digest: &str, actor: &str) -> serde_json::Value {
        let ids = preview_batch_ids(conn, from_kind, from_id, to_id);
        confirm(conn, from_kind, from_id, to_id, digest, &ids, actor)
    }


    fn queue(conn: &rusqlite::Connection, cfg: &crate::config::Config, body: &str, scope_id: &str) -> String {
        let result = MemoryService::remember(conn, cfg, body, None, "cursor", Some("project"), Some(scope_id), "collector:cursor", false, None);
        assert_eq!(result["status"], "queued");
        result["inboxId"].as_str().unwrap().to_string()
    }

    fn fingerprint_rows(conn: &rusqlite::Connection) -> Vec<(String, String, String, String, String, i64, String)> {
        let mut stmt = conn
            .prepare("SELECT id, collector, source_key, scope_kind, scope_id, rules_version, content_hash FROM collect_fingerprints ORDER BY id")
            .expect("stmt");
        stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .expect("map")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("rows")
    }

    #[test]
    fn repository_scope_validation_rejects_paths() {
        assert!(is_repository_scope_id("OneLedger"));
        assert!(is_repository_scope_id("  CofoeAirLink_Web "));
        assert!(!is_repository_scope_id(""));
        assert!(!is_repository_scope_id("skills\\system\\skill"));
        assert!(!is_repository_scope_id("E:/work"));
        assert!(!is_repository_scope_id("E:\\work"));
        assert!(!is_repository_scope_id("C:Users"));
        assert!(!is_repository_scope_id("."));
        assert!(!is_repository_scope_id(".."));
    }

    #[test]
    fn preview_confirm_revert_roundtrip_moves_only_proposed() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        let queued = queue(&conn, &cfg, "路径型作用域材料一", "skills\\system\\skill");
        queue(&conn, &cfg, "路径型作用域材料二", "skills\\system\\skill");
        // 目标作用域已有正式记忆与材料
        let direct = MemoryService::remember(&conn, &cfg, "目标项目已有记忆", None, "mcp:a", Some("project"), Some("Target"), "a", false, Some(0));
        assert_eq!(direct["status"], "stored");
        queue(&conn, &cfg, "目标项目已有材料", "Target");
        // 一条 rejected 材料不应被移动
        let rejected_source = queue(&conn, &cfg, "准备拒收的材料", "skills\\system\\skill");
        assert!(MemoryService::reject_inbox(&conn, &rejected_source, "admin"));

        let view = preview(&conn, "project", "skills\\system\\skill", "Target").expect("preview");
        assert_eq!(view["pending"], 2);
        assert_eq!(view["batch"], 2);
        assert_eq!(view["remaining"], 0);
        assert_eq!(view["toPending"], 1);
        assert_eq!(view["toMemory"]["rev"], 1);
        assert!(view["blocked"].as_array().expect("blocked").is_empty());
        // 本批样本有证据（B-07：全批元数据）
        assert_eq!(view["batchItems"].as_array().expect("sample").len(), 2);
        let digest = view["digest"].as_str().expect("digest").to_string();

        let applied = confirm_batch(&conn, "project", "skills\\system\\skill", "Target", &digest, "admin");
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["moved"], 2);
        assert_eq!(applied["remaining"], 0);
        let operation_id = applied["operationId"].as_str().expect("op id").to_string();

        // 只有 proposed 材料移动；rejected 留在原作用域；正式记忆不动
        assert_eq!(pending_count(&conn, "project", "skills\\system\\skill").expect("count"), 0);
        let kept = store::list_inbox_status(&conn, "rejected", 10, 0).expect("rejected");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].scope_id, "skills\\system\\skill");
        let active = store::list_active_by_scope(&conn, "project", "Target").expect("memory");
        assert_eq!(active[0].rev, 1);
        assert_eq!(active[0].body, "目标项目已有记忆");

        // 批次精确 ID 落在 item 表，moved_ids 不再塞大列表
        let items = store::get_merge_operation_batch(&conn, &operation_id).expect("items");
        assert_eq!(items.len(), 2);
        let op = store::get_merge_operation(&conn, &operation_id).expect("op").expect("row");
        assert!(op.moved_ids.is_empty(), "new operations must not store ID lists in moved_ids");
        // M-02：确认记录的来源分布是全量（无 top20 截断），总和必须等于本批移动数
        let breakdown_sum: i64 = op.source_breakdown.as_object().expect("breakdown").values().filter_map(|v| v.as_i64()).sum();
        assert_eq!(breakdown_sum, op.moved_count, "operation breakdown must sum to moved count");

        // 旧预览失效：状态已变，重复确认返回 conflict
        let replay = confirm_batch(&conn, "project", "skills\\system\\skill", "Target", &digest, "admin");
        assert_eq!(replay["status"], "conflict");

        // 撤销：全部移回
        let reverted = revert(&conn, &operation_id, "admin");
        assert_eq!(reverted["status"], "reverted");
        assert_eq!(reverted["reverted"], 2);
        assert_eq!(pending_count(&conn, "project", "skills\\system\\skill").expect("count"), 2);
        assert_eq!(pending_count(&conn, "project", "Target").expect("count"), 1);

        // 重复撤销幂等
        let again = revert(&conn, &operation_id, "admin");
        assert_eq!(again["status"], "already-reverted");

        let listed = list_operations(&conn, 10, 0);
        assert_eq!(listed["total"], 1);
        assert_eq!(listed["operations"][0]["status"], "reverted");
        let _ = queued;
    }

    #[test]
    fn confirm_conflicts_when_state_changed_after_preview() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        queue(&conn, &cfg, "归并前材料", "bad\\path");
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest = view["digest"].as_str().expect("digest").to_string();
        // 预览后又排入一条新材料
        queue(&conn, &cfg, "预览之后新来的材料", "bad\\path");
        let applied = confirm_batch(&conn, "project", "bad\\path", "Good", &digest, "admin");
        assert_eq!(applied["status"], "conflict");
        assert!(applied["preview"].is_object());
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 2);
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 0);
    }

    /// P0-05：等数量/等 rowid 的替换集合、同批一条离队、目标草稿/记忆变化都必须让旧 digest 失效。
    #[test]
    fn digest_binds_exact_batch_ids_not_count_or_rowid() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        let first = queue(&conn, &cfg, "集合成员甲", "bad\\path");
        let second = queue(&conn, &cfg, "集合成员乙", "bad\\path");
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest = view["digest"].as_str().expect("digest").to_string();

        // 等数量替换：删掉一条、补进一条不同 ID（数量不变，旧实现 COUNT 不变即不设防）
        assert!(MemoryService::reject_inbox(&conn, &first, "admin"));
        let replacement = queue(&conn, &cfg, "替换进来的新成员", "bad\\path");
        assert_ne!(replacement, second);
        let applied = confirm_batch(&conn, "project", "bad\\path", "Good", &digest, "admin");
        assert_eq!(applied["status"], "conflict", "same count with different ids must invalidate the preview");
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 2);

        // 同批一条离队（归并前被处理）
        let view2 = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest2 = view2["digest"].as_str().expect("digest").to_string();
        let done = MemoryService::confirm_sources(&conn, &cfg, &[replacement], "蒸馏消费了一条", None, "admin", Some(0), None);
        assert_eq!(done["status"], "stored");
        let applied2 = confirm_batch(&conn, "project", "bad\\path", "Good", &digest2, "admin");
        assert_eq!(applied2["status"], "conflict");

        // 目标记忆 rev 变化使预览失效
        let view3 = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest3 = view3["digest"].as_str().expect("digest").to_string();
        let advanced = MemoryService::remember(&conn, &cfg, "目标被写入新版本", None, "mcp:x", Some("project"), Some("Good"), "x", false, Some(0));
        assert_eq!(advanced["status"], "stored");
        let applied3 = confirm_batch(&conn, "project", "bad\\path", "Good", &digest3, "admin");
        assert_eq!(applied3["status"], "conflict");

        // 新增目标草稿使预览失效
        let view4 = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest4 = view4["digest"].as_str().expect("digest").to_string();
        crate::distill_job::upsert_draft(
            &conn,
            &crate::distill_job::DistillDraft {
                id: "dd_digest".into(),
                scope_kind: "project".into(),
                scope_id: "Good".into(),
                title: "目标草稿".into(),
                body: "目标草稿正文".into(),
                source_ids: vec![],
                source_fingerprints: vec![],
                expected_rev: 0,
                provider: "stub".into(),
                model: "stub".into(),
                status: "pending".into(),
                stale_reason: String::new(),
                error: String::new(),
                attempts: 1,
                created_at: crate::util::now_iso(),
                updated_at: crate::util::now_iso(),
            },
        )
        .expect("draft");
        let applied4 = confirm_batch(&conn, "project", "bad\\path", "Good", &digest4, "admin");
        assert_eq!(applied4["status"], "conflict", "new target draft must invalidate the old preview");
        let fresh_blocked = applied4["preview"]["blocked"].as_array().expect("fresh preview blocked");
        assert!(!fresh_blocked.is_empty(), "fresh preview must surface the draft block");
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 1);
        let _ = second;
    }

    /// P0-06：一次确认最多 MERGE_BATCH_LIMIT 条，剩余分批；每批是独立可撤销 operation。
    #[test]
    fn confirm_moves_at_most_batch_limit_per_operation() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        // 1005 条：首批 1000，剩余 5
        for index in 0..1005 {
            queue(&conn, &cfg, &format!("批量材料第 {index:05} 号，内容足够长以通过限制"), "bad\\path");
        }
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        assert_eq!(view["pending"], 1005);
        assert_eq!(view["batch"], 1000);
        assert_eq!(view["remaining"], 5);
        assert_eq!(view["batchLimit"], 1000);
        let digest1 = view["digest"].as_str().expect("digest").to_string();

        let applied1 = confirm_batch(&conn, "project", "bad\\path", "Good", &digest1, "admin");
        assert_eq!(applied1["status"], "applied");
        assert_eq!(applied1["moved"], 1000);
        assert_eq!(applied1["remaining"], 5);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 5);
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 1000);

        // 第二批
        let view2 = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        assert_eq!(view2["batch"], 5);
        assert_eq!(view2["remaining"], 0);
        let applied2 = confirm_batch(&conn, "project", "bad\\path", "Good", view2["digest"].as_str().expect("digest"), "admin");
        assert_eq!(applied2["status"], "applied");
        assert_eq!(applied2["moved"], 5);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 0);

        // 两批独立可撤销：撤销第二批不影响第一批
        let op2 = applied2["operationId"].as_str().expect("op2").to_string();
        let reverted2 = revert(&conn, &op2, "admin");
        assert_eq!(reverted2["status"], "reverted");
        assert_eq!(reverted2["reverted"], 5);
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 1000);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 5);

        // 撤销第一批：精确 1000 条全部移回，目标旧有材料（无）与后来新增不受影响
        let op1 = applied1["operationId"].as_str().expect("op1").to_string();
        let reverted1 = revert(&conn, &op1, "admin");
        assert_eq!(reverted1["status"], "reverted");
        assert_eq!(reverted1["reverted"], 1000);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 1005);
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 0);
    }

    /// P0-03：归并/撤销绝不移动或删除指纹行；逐字段比对。
    #[test]
    fn merge_and_revert_leave_fingerprints_untouched() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        // 来源作用域一条指纹、目标作用域一条同键同内容指纹（旧实现会合并删除其一）
        let files = vec![(
            "C:/work/Demo/AGENTS.md".to_string(),
            "同键同内容的仓库约定".to_string(),
            "bad\\path".to_string(),
        )];
        let first = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(first.queued, 1);
        store::insert_fingerprint(&conn, "projects", "C:/work/Demo/AGENTS.md", "project", "Target", &crate::util::sha256_hex("同键同内容的仓库约定"), crate::util::SCAN_RULES_VERSION, "older").expect("fp target");
        queue(&conn, &cfg, "来源作用域的普通材料", "bad\\path");

        // 目标作用域归并后新生指纹（归并期间产生的新扫描）
        let new_files = vec![(
            "C:/work/Demo/README.md".to_string(),
            "目标项目新增扫描文件".to_string(),
            "Target".to_string(),
        )];
        let grown = MemoryService::ingest_collected(&conn, "projects", &new_files);
        assert_eq!(grown.queued, 1);

        let before = fingerprint_rows(&conn);
        assert_eq!(before.len(), 3);

        let view = preview(&conn, "project", "bad\\path", "Target").expect("preview");
        let applied = confirm_batch(&conn, "project", "bad\\path", "Target", view["digest"].as_str().expect("digest"), "admin");
        assert_eq!(applied["status"], "applied");
        let after_confirm = fingerprint_rows(&conn);
        assert_eq!(after_confirm, before, "confirm must not touch fingerprint rows");

        let reverted = revert(&conn, applied["operationId"].as_str().expect("op"), "admin");
        assert_eq!(reverted["status"], "reverted");
        let after_revert = fingerprint_rows(&conn);
        assert_eq!(after_revert, before, "revert must not touch fingerprint rows");

        // 指纹保持原作用域：AGENTS.md 的指纹在来源 bad\path，同键副本与 README 在 Target
        let from_scope = after_revert.iter().filter(|(_, _, _, kind, id, _, _)| kind == "project" && id == "bad\\path").count();
        let to_scope = after_revert.iter().filter(|(_, _, _, kind, id, _, _)| kind == "project" && id == "Target").count();
        assert_eq!(from_scope, 1);
        assert_eq!(to_scope, 2);
    }

    /// P0-03：两次不同来源归并同一目标，依次确认/撤销后指纹行集合逐字段不变。
    #[test]
    fn two_sequential_merges_keep_fingerprints_intact() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        queue(&conn, &cfg, "来源甲的材料", "bad\\one");
        queue(&conn, &cfg, "来源乙的材料", "bad\\two");
        let target_memory = MemoryService::remember(&conn, &cfg, "目标已有记忆", None, "mcp:a", Some("project"), Some("Target"), "a", false, Some(0));
        assert_eq!(target_memory["status"], "stored");
        let files = vec![(
            "C:/work/Demo/NOTES.md".to_string(),
            "目标扫描文件内容".to_string(),
            "Target".to_string(),
        )];
        MemoryService::ingest_collected(&conn, "projects", &files);
        let before = fingerprint_rows(&conn);

        let view1 = preview(&conn, "project", "bad\\one", "Target").expect("preview");
        let applied1 = confirm_batch(&conn, "project", "bad\\one", "Target", view1["digest"].as_str().expect("digest"), "admin");
        assert_eq!(applied1["status"], "applied");
        let view2 = preview(&conn, "project", "bad\\two", "Target").expect("preview");
        let applied2 = confirm_batch(&conn, "project", "bad\\two", "Target", view2["digest"].as_str().expect("digest"), "admin");
        assert_eq!(applied2["status"], "applied");
        assert_eq!(fingerprint_rows(&conn), before, "both confirms must not touch fingerprints");

        let reverted2 = revert(&conn, applied2["operationId"].as_str().expect("op2"), "admin");
        assert_eq!(reverted2["status"], "reverted");
        let reverted1 = revert(&conn, applied1["operationId"].as_str().expect("op1"), "admin");
        assert_eq!(reverted1["status"], "reverted");
        assert_eq!(fingerprint_rows(&conn), before, "both reverts must not touch fingerprints");
    }

    /// P0-04：归并后同一文件重扫不重复入队（指纹留原作用域，作用域指纹命中即跳过）；
    /// 改变内容恰好新入队一次。
    #[test]
    fn rescan_after_merge_stays_quiet_until_content_changes() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        let files = vec![(
            "C:/work/Demo/AGENTS.md".to_string(),
            "仓库约定材料内容".to_string(),
            "bad\\path".to_string(),
        )];
        let first = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(first.queued, 1);
        let view = preview(&conn, "project", "bad\\path", "Target").expect("preview");
        let applied = confirm_batch(&conn, "project", "bad\\path", "Target", view["digest"].as_str().expect("digest"), "admin");
        assert_eq!(applied["status"], "applied");

        // 归并后重扫同一文件：指纹仍在采集上报的作用域，命中即跳过
        let rescan = MemoryService::ingest_collected(&conn, "projects", &files);
        assert_eq!(rescan.queued, 0);
        assert_eq!(rescan.skipped, 1);

        // 采集器上报作用域变化（路径推导规则变化）：稳定来源键跨作用域命中同一文件，仍跳过
        let moved_scope = vec![(
            "C:/work/Demo/AGENTS.md".to_string(),
            "仓库约定材料内容".to_string(),
            "Target".to_string(),
        )];
        let rescan_moved = MemoryService::ingest_collected(&conn, "projects", &moved_scope);
        assert_eq!(rescan_moved.queued, 0, "same content under a new scope must be skipped via global fingerprint");
        assert_eq!(rescan_moved.skipped, 1);

        // 内容变化：恰好新入队一次
        let changed = vec![(
            "C:/work/Demo/AGENTS.md".to_string(),
            "仓库约定材料内容版本二".to_string(),
            "Target".to_string(),
        )];
        let rescan_changed = MemoryService::ingest_collected(&conn, "projects", &changed);
        assert_eq!(rescan_changed.queued, 1);
        let rescan_again = MemoryService::ingest_collected(&conn, "projects", &changed);
        assert_eq!(rescan_again.queued, 0);
    }

    #[test]
    fn confirm_blocked_by_pending_draft() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        queue(&conn, &cfg, "有待审草稿的材料", "bad\\path");
        crate::distill_job::upsert_draft(
            &conn,
            &crate::distill_job::DistillDraft {
                id: "dd_block".into(),
                scope_kind: "project".into(),
                scope_id: "bad\\path".into(),
                title: "旧草稿".into(),
                body: "旧草稿正文".into(),
                source_ids: vec![],
                source_fingerprints: vec![],
                expected_rev: 0,
                provider: "stub".into(),
                model: "stub".into(),
                status: "pending".into(),
                stale_reason: String::new(),
                error: String::new(),
                attempts: 1,
                created_at: crate::util::now_iso(),
                updated_at: crate::util::now_iso(),
            },
        )
        .expect("draft");
        // 草稿存在时：预览明确阻断，确认也被阻断
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        assert!(!view["blocked"].as_array().expect("blocked").is_empty());
        let digest = view["digest"].as_str().expect("digest").to_string();
        let applied = confirm_batch(&conn, "project", "bad\\path", "Good", &digest, "admin");
        assert_eq!(applied["status"], "blocked");
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 1);
    }

    #[test]
    fn revert_refused_when_any_moved_item_left_target_scope() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        let first = queue(&conn, &cfg, "撤销场景材料一", "bad\\path");
        queue(&conn, &cfg, "撤销场景材料二", "bad\\path");
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest = view["digest"].as_str().expect("digest").to_string();
        let applied = confirm_batch(&conn, "project", "bad\\path", "Good", &digest, "admin");
        assert_eq!(applied["status"], "applied");
        let operation_id = applied["operationId"].as_str().expect("op id").to_string();
        // 其中一条已被蒸馏处理（从队列移除）
        let done = MemoryService::confirm_sources(&conn, &cfg, &[first], "蒸馏后的整篇", None, "admin", Some(0), None);
        assert_eq!(done["status"], "stored");
        let refused = revert(&conn, &operation_id, "admin");
        assert_eq!(refused["status"], "conflict");
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 1);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 0);
    }

    #[test]
    fn confirm_rejects_invalid_targets() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        queue(&conn, &cfg, "材料", "bad\\path");
        for bad in ["", "a\\b", "E:\\x", ".", "..", "bad\\path"] {
            let result = confirm(&conn, "project", "bad\\path", bad, "digest", &["in_dummy".to_string()], "admin");
            assert_eq!(result["status"], "error", "target {bad:?} must be refused");
        }
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 1);
    }

    /// P0-06 规模验证（ignored：显式运行 cargo test --offline --lib -- --ignored scope_merge_scale）。
    /// 合成库 140,000+ 条、1,800+ 作用域、一个 73,544 条作用域：
    /// 服务层全批循环归并 + 每批耗时 p50/p95/max + exact ID 抽查 + 撤销一批不影响其他批。
    #[test]
    #[ignore = "140k 合成库规模压测，显式运行：cargo test --offline --lib -- --ignored scope_merge_scale"]
    fn scope_merge_scale_batches_over_140k_with_73k_scope() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        let now = crate::util::now_iso();
        let mut total_rows: i64 = 0;
        // 1,799 个 37 条的小作用域 = 66,563 条
        conn.execute("BEGIN IMMEDIATE", []).expect("begin");
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids)
                     VALUES (?1, ?2, ?3, 'cursor', 'project', ?4, 'public', 0, ?5, 'proposed', '')",
                )
                .expect("stmt");
            let mut id_counter = 0i64;
            for scope in 0..1_799 {
                let scope_id = format!("repo_{scope:05}");
                for item in 0..37 {
                    id_counter += 1;
                    let id = format!("in_s{id_counter:07}");
                    let body = format!("小作用域材料 {scope}-{item}，内容足够长以通过最短限制要求");
                    stmt.execute(params![id, body.clone(), body, scope_id, now]).expect("insert");
                }
            }
            // 大作用域 73,544 条
            for item in 0..73_544 {
                id_counter += 1;
                let id = format!("in_s{id_counter:07}");
                let body = format!("大作用域材料 {item}，内容足够长以通过最短限制要求");
                stmt.execute(params![id, body.clone(), body, "huge_scope", now]).expect("insert");
            }
            total_rows = id_counter;
        }
        conn.execute("COMMIT", []).expect("commit");
        assert_eq!(total_rows, 1_799 * 37 + 73_544); // 140,207
        assert_eq!(pending_count(&conn, "project", "huge_scope").expect("count"), 73_544);

        // 全批循环：73,544 条 = 74 批（73 批 1000 + 1 批 544）
        let started = std::time::Instant::now();
        let mut batch_ms: Vec<u128> = Vec::new();
        let mut moved_total = 0i64;
        let mut operation_ids: Vec<String> = Vec::new();
        loop {
            let batch_start = std::time::Instant::now();
            let view = preview(&conn, "project", "huge_scope", "HugeTarget").expect("preview");
            if view["batch"].as_i64().unwrap_or(0) == 0 {
                break;
            }
            let batch_ids: Vec<String> = view["batchItems"].as_array().expect("batchItems").iter().filter_map(|item| item["id"].as_str().map(str::to_string)).collect();
            let applied = confirm(&conn, "project", "huge_scope", "HugeTarget", view["digest"].as_str().expect("digest"), &batch_ids, "admin");
            assert_eq!(applied["status"], "applied", "batch confirm failed: {applied}");
            moved_total += applied["moved"].as_i64().unwrap_or(0);
            operation_ids.push(applied["operationId"].as_str().expect("op").to_string());
            batch_ms.push(batch_start.elapsed().as_millis());
            if view["remaining"].as_i64().unwrap_or(0) == 0 && applied["remaining"].as_i64().unwrap_or(0) == 0 {
                break;
            }
        }
        let loop_elapsed = started.elapsed();
        assert_eq!(moved_total, 73_544);
        assert_eq!(operation_ids.len(), 74);
        assert_eq!(pending_count(&conn, "project", "huge_scope").expect("count"), 0);
        // 1,799 个小作用域仍在
        assert_eq!(pending_count(&conn, "project", "repo_00000").expect("count"), 37);

        // 每批 exact ID 无遗漏/无重复
        let item_total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scope_merge_operation_items WHERE operation_id IN (SELECT id FROM scope_merge_operations)",
                [],
                |row| row.get(0),
            )
            .expect("items");
        assert_eq!(item_total, 73_544);
        let distinct: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT inbox_id) FROM scope_merge_operation_items WHERE operation_id IN (SELECT id FROM scope_merge_operations)",
                [],
                |row| row.get(0),
            )
            .expect("distinct");
        assert_eq!(distinct, 73_544);

        // 批次耗时统计
        batch_ms.sort_unstable();
        let p50 = batch_ms[batch_ms.len() / 2];
        let p95 = batch_ms[(batch_ms.len() as f32 * 0.95) as usize];
        let max = batch_ms[batch_ms.len() - 1];
        println!("scope_merge_scale: batches={} total_loop={loop_elapsed:?} p50={p50}ms p95={p95}ms max={max}ms", batch_ms.len());

        // M-03：操作列表（概要字段、单次分页 SQL）在大操作样本上的耗时
        let list_start = std::time::Instant::now();
        let listed = list_operations(&conn, 20, 0);
        let list_ms = list_start.elapsed().as_millis();
        assert_eq!(listed["total"], 74);
        assert_eq!(listed["operations"].as_array().expect("ops").len(), 20);
        let page3 = list_operations(&conn, 20, 40);
        assert_eq!(page3["operations"].as_array().expect("ops").len(), 20, "74 ops: offset 40 still yields a full page");
        let page4 = list_operations(&conn, 20, 60);
        assert_eq!(page4["operations"].as_array().expect("ops").len(), 14, "last page holds the remainder");
        println!("scope_merge_scale: list20={list_ms}ms over 74 operations");

        // M-02：每批确认记录的分布总和等于该批移动数（抽第一与最后一批）
        for op_id in [operation_ids.first().expect("op1"), operation_ids.last().expect("opN")] {
            let (sum, moved): (i64, i64) = conn
                .query_row(
                    "SELECT (SELECT COALESCE(SUM(value), 0) FROM json_each(source_breakdown, '$')), moved_count
                     FROM scope_merge_operations WHERE id = ?1",
                    [op_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("breakdown row");
            assert_eq!(sum, moved, "batch breakdown must sum to moved count");
        }

        // 撤销中间一批：只影响该批，不动其他批、目标旧行或后来新增行
        let target_before: i64 = pending_count(&conn, "project", "HugeTarget").expect("count");
        let mid_op = &operation_ids[40];
        let mid_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM scope_merge_operation_items WHERE operation_id = ?1", [mid_op], |row| row.get(0))
            .expect("mid count");
        let reverted = revert(&conn, mid_op, "admin");
        assert_eq!(reverted["status"], "reverted");
        assert_eq!(reverted["reverted"].as_i64().unwrap_or(0), mid_count);
        assert_eq!(pending_count(&conn, "project", "HugeTarget").expect("count"), target_before - mid_count);
        assert_eq!(pending_count(&conn, "project", "huge_scope").expect("count"), mid_count);
        // 目标总行数守恒：其他批不动
        let target_now: i64 = conn
            .query_row("SELECT COUNT(*) FROM inbox WHERE scope_kind = 'project' AND scope_id = 'HugeTarget'", [], |row| row.get(0))
            .expect("target all");
        assert_eq!(target_now, moved_total - mid_count);

        // 进程中断后可继续：来源剩余批次重新预览即可归并（独立 operation）
        let resumed = preview(&conn, "project", "huge_scope", "HugeTarget").expect("resume preview");
        let resumed_ids: Vec<String> = resumed["batchItems"].as_array().expect("batchItems").iter().filter_map(|item| item["id"].as_str().map(str::to_string)).collect();
        let resumed_confirm = confirm(&conn, "project", "huge_scope", "HugeTarget", resumed["digest"].as_str().expect("digest"), &resumed_ids, "admin");
        assert_eq!(resumed_confirm["status"], "applied");

        // 幂等撤销
        let again = revert(&conn, mid_op, "admin");
        assert_eq!(again["status"], "already-reverted");
    }

    #[test]
    fn fingerprint_damage_report_is_read_only_and_lists_operations() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        queue(&conn, &cfg, "报告场景材料", "bad\\path");
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let applied = confirm_batch(&conn, "project", "bad\\path", "Good", view["digest"].as_str().expect("digest"), "admin");
        assert_eq!(applied["status"], "applied");
        let report = fingerprint_damage_report(&conn).expect("report");
        assert_eq!(report["status"], "report");
        let ops = report["operations"].as_array().expect("ops");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["fromScope"], "project:bad\\path");
        assert_eq!(ops[0]["toScope"], "project:Good");
        assert!(report["note"].as_str().expect("note").contains("备份"));
    }

    /// B-07：确认只移动显式勾选的精确 ID 子集；未勾选（含混入本批的其他仓库材料）留在原队列。
    #[test]
    fn confirm_moves_only_the_reviewed_id_subset() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        let belong_a = queue(&conn, &cfg, "属于目标仓库的材料", "bad\\path");
        let belong_b = queue(&conn, &cfg, "混进来的其他仓库材料", "bad\\path");
        queue(&conn, &cfg, "尚未核对的材料", "bad\\path");
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        assert_eq!(view["batch"], 3);
        let digest = view["digest"].as_str().expect("digest").to_string();

        // 不勾选不能归并
        let empty = confirm(&conn, "project", "bad\\path", "Good", &digest, &[], "admin");
        assert_eq!(empty["status"], "error");
        // 勾选 ID 重复被拒绝
        let dup = confirm(&conn, "project", "bad\\path", "Good", &digest, &[belong_a.clone(), belong_a.clone()], "admin");
        assert_eq!(dup["status"], "error");
        // 只勾选核对过的 1 条：目标只出现这一条，其余留在来源
        let applied = confirm(&conn, "project", "bad\\path", "Good", &digest, &[belong_a.clone()], "admin");
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["moved"], 1);
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 1);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 2);
        // 操作明细恰好是勾选的那条
        let op_id = applied["operationId"].as_str().expect("op").to_string();
        let items = store::get_merge_operation_batch(&conn, &op_id).expect("items");
        assert_eq!(items, vec![belong_a.clone()]);
        // 撤销只移回勾选过的一条
        let reverted = revert(&conn, &op_id, "admin");
        assert_eq!(reverted["status"], "reverted");
        assert_eq!(reverted["reverted"], 1);
        assert_eq!(pending_count(&conn, "project", "bad\\path").expect("count"), 3);
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 0);
        let _ = belong_b;
    }

    /// C-01：来源作用域在本批之外新增/移走一条（本批 ID 不变）必须使旧预览失效。
    #[test]
    fn digest_invalidates_when_out_of_batch_source_changes() {
        let conn = db::open_db(":memory:").expect("db");
        let cfg = config::default_config();
        for index in 0..4 {
            queue(&conn, &cfg, &format!("本批材料第 {index} 条，内容足够长以通过限制"), "bad\\path");
        }
        let view = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest = view["digest"].as_str().expect("digest").to_string();
        // 本批成员不变，来源作用域新增一条：总数变化 → 旧 digest 失效
        queue(&conn, &cfg, "本批之外新增的材料，内容足够长以通过限制", "bad\\path");
        let stale = confirm_batch(&conn, "project", "bad\\path", "Good", &digest, "admin");
        assert_eq!(stale["status"], "conflict", "out-of-batch source growth must invalidate the preview");
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 0);
        // 本批成员不变，来源作用域移走一条（拒收）：总数变化 → 旧 digest 失效
        let view2 = preview(&conn, "project", "bad\\path", "Good").expect("preview");
        let digest2 = view2["digest"].as_str().expect("digest").to_string();
        let first = view2["batchItems"].as_array().expect("items")[0]["id"].as_str().expect("id").to_string();
        assert!(MemoryService::reject_inbox(&conn, &first, "admin"));
        let stale2 = confirm_batch(&conn, "project", "bad\\path", "Good", &digest2, "admin");
        assert_eq!(stale2["status"], "conflict", "out-of-batch source removal must invalidate the preview");
        assert_eq!(pending_count(&conn, "project", "Good").expect("count"), 0);
    }
}
