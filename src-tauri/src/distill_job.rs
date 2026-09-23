use crate::config::Config;
use crate::models::InboxRecord;
use crate::scan::scan_and_redact;
use crate::store;
use crate::util::{new_id, now_iso};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 每个作用域最多送给模型的安全材料条数，限制输入长度。
const MAX_SOURCES: usize = 12;
const MAX_SOURCE_CHARS: usize = 4000;
const MAX_TOTAL_CHARS: usize = 24_000;
/// 同一草稿的自动重试上限，超过后只能由管理员重新发起。
pub const MAX_ATTEMPTS: i64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillDraft {
    pub id: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub title: String,
    pub body: String,
    pub source_ids: Vec<String>,
    pub source_fingerprints: Vec<String>,
    pub expected_rev: i64,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub stale_reason: String,
    pub error: String,
    pub attempts: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillTask {
    pub scope_kind: String,
    pub scope_id: String,
    pub pending: i64,
    pub oldest_waiting_at: Option<String>,
    pub high_signal: i64,
    pub sources: Vec<serde_json::Value>,
    pub draft: Option<DistillDraft>,
    pub last_result: Option<serde_json::Value>,
}

fn split_list(value: &str) -> Vec<String> {
    value.split('\u{1f}').filter(|item| !item.is_empty()).map(str::to_string).collect()
}

fn join_list(items: &[String]) -> String {
    items.join("\u{1f}")
}

fn map_draft(row: &rusqlite::Row) -> rusqlite::Result<DistillDraft> {
    let source_ids: String = row.get("source_ids")?;
    let fingerprints: String = row.get("source_fingerprints")?;
    Ok(DistillDraft {
        id: row.get("id")?,
        scope_kind: row.get("scope_kind")?,
        scope_id: row.get("scope_id")?,
        title: row.get("title")?,
        body: row.get("body")?,
        source_ids: split_list(&source_ids),
        source_fingerprints: split_list(&fingerprints),
        expected_rev: row.get("expected_rev")?,
        provider: row.get("provider")?,
        model: row.get("model")?,
        status: row.get("status")?,
        stale_reason: row.get("stale_reason")?,
        error: row.get("error")?,
        attempts: row.get("attempts")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn upsert_draft(conn: &Connection, draft: &DistillDraft) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO distill_drafts (
           id, scope_kind, scope_id, title, body, source_ids, source_fingerprints,
           expected_rev, provider, model, status, stale_reason, error, attempts, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, body = excluded.body,
           source_ids = excluded.source_ids, source_fingerprints = excluded.source_fingerprints,
           expected_rev = excluded.expected_rev, provider = excluded.provider, model = excluded.model,
           status = excluded.status, stale_reason = excluded.stale_reason, error = excluded.error,
           attempts = excluded.attempts, updated_at = excluded.updated_at",
        rusqlite::params![
            draft.id,
            draft.scope_kind,
            draft.scope_id,
            draft.title,
            draft.body,
            join_list(&draft.source_ids),
            join_list(&draft.source_fingerprints),
            draft.expected_rev,
            draft.provider,
            draft.model,
            draft.status,
            draft.stale_reason,
            draft.error,
            draft.attempts,
            draft.created_at,
            draft.updated_at
        ],
    )?;
    Ok(())
}

pub fn latest_draft(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<Option<DistillDraft>> {
    conn.query_row(
        "SELECT * FROM distill_drafts WHERE scope_kind = ?1 AND scope_id = ?2 ORDER BY updated_at DESC LIMIT 1",
        rusqlite::params![kind, id],
        map_draft,
    )
    .optional_opt()
}

trait OptionalOpt<T> {
    fn optional_opt(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalOpt<T> for rusqlite::Result<T> {
    fn optional_opt(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

pub fn get_draft(conn: &Connection, id: &str) -> rusqlite::Result<Option<DistillDraft>> {
    conn.query_row("SELECT * FROM distill_drafts WHERE id = ?1", [id], map_draft).optional_opt()
}

fn source_fingerprint(item: &InboxRecord) -> String {
    format!("{}:{}", item.id, crate::util::sha256_hex(&format!("{}\n{}", item.title, item.body)))
}

/// 采集完成后按作用域聚合待蒸馏材料，附上待审草稿与最近一次处理结果。
/// 查询次数固定为 3 次，与作用域数量无关。
pub fn tasks(conn: &Connection) -> rusqlite::Result<Vec<DistillTask>> {
    let summary = store::inbox_scope_summary(conn)?;
    let mut samples: std::collections::HashMap<(String, String), Vec<InboxRecord>> = std::collections::HashMap::new();
    for item in store::inbox_samples_by_scope(conn, 40)? {
        samples.entry((item.scope_kind.clone(), item.scope_id.clone())).or_default().push(item);
    }
    let mut drafts = all_latest_drafts(conn)?;
    let mut out = Vec::new();
    for (scope_kind, scope_id, pending, high_signal, oldest_at, _) in summary {
        let key = (scope_kind.clone(), scope_id.clone());
        let draft = drafts.remove(&key);
        let sources: Vec<serde_json::Value> = samples
            .get(&key)
            .map(|items| {
                items
                    .iter()
                    .map(|item| {
                        serde_json::json!({
                            "id": item.id,
                            "title": item.title,
                            "source": item.source,
                            "sensitivity": item.sensitivity,
                            "createdAt": item.created_at,
                            "redacted": item.redacted == 1,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let last_result = draft.as_ref().map(|draft| {
            serde_json::json!({
                "status": draft.status,
                "error": draft.error,
                "attempts": draft.attempts,
                "at": draft.updated_at,
            })
        });
        out.push(DistillTask {
            scope_kind,
            scope_id,
            pending,
            oldest_waiting_at: oldest_at,
            high_signal,
            sources,
            draft,
            last_result,
        });
    }
    Ok(out)
}

/// 一次取回每个作用域的最新草稿。
fn all_latest_drafts(conn: &Connection) -> rusqlite::Result<std::collections::HashMap<(String, String), DistillDraft>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM (
           SELECT distill_drafts.*,
                  ROW_NUMBER() OVER (PARTITION BY scope_kind, scope_id ORDER BY updated_at DESC) AS scope_rank
           FROM distill_drafts
         ) WHERE scope_rank = 1",
    )?;
    let rows = stmt.query_map([], map_draft)?;
    let mut out = std::collections::HashMap::new();
    for row in rows {
        let draft = row?;
        out.insert((draft.scope_kind.clone(), draft.scope_id.clone()), draft);
    }
    Ok(out)
}

/// 仍待审核的草稿，供接口在返回任务前刷新过期状态。
pub fn pending_drafts(conn: &Connection) -> rusqlite::Result<Vec<DistillDraft>> {
    let mut stmt = conn.prepare("SELECT * FROM distill_drafts WHERE status = 'pending' ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], map_draft)?;
    rows.collect()
}

fn build_prompt(task_scope: &str, title: &str, sources: &[(String, String)]) -> (String, String) {
    let mut system = String::from(
        "你是 OneLedger 的记忆蒸馏助手。输入是某个作用域下已脱敏的采集材料，请输出一份整篇中文/原文语言记忆。\
         要求：整篇覆盖、不要追加原文、不要逐条罗列、不要编造输入中没有的事实；保留关键决策、约定、路径与流程；\
         只输出记忆正文，第一行作为标题（不超过 60 字），随后空一行再写正文。",
    );
    system.push_str(&format!("\n当前作用域：{task_scope}；已有标题：{title}"));
    let mut user = String::new();
    for (index, (source, body)) in sources.iter().enumerate() {
        let mut clipped = body.chars().take(MAX_SOURCE_CHARS).collect::<String>();
        if body.chars().count() > MAX_SOURCE_CHARS {
            clipped.push_str("\n…（已截断）");
        }
        let next = format!("【材料 {}｜来源 {}】\n{}\n\n", index + 1, source, clipped);
        if user.chars().count() + next.chars().count() > MAX_TOTAL_CHARS {
            break;
        }
        user.push_str(&next);
    }
    (system, user)
}

/// 只把通过安全扫描的材料交给模型；任何残留 secret 直接排除并记录。
/// 二次验证：替换后的文本仍命中规则时同样排除。
fn safe_sources(items: &[InboxRecord]) -> (Vec<(String, String)>, Vec<String>) {
    let mut safe = Vec::new();
    let mut blocked = Vec::new();
    for item in items {
        if item.sensitivity == "secret" || item.queue_status == "rejected" {
            blocked.push(item.id.clone());
            continue;
        }
        let scanned = scan_and_redact(&format!("{}\n{}", item.title, item.body));
        if scanned.highest == "secret" || !crate::scan::verify_redacted(&scanned.clean_text).is_empty() {
            blocked.push(item.id.clone());
            continue;
        }
        safe.push((item.source.clone(), scanned.clean_text));
    }
    (safe, blocked)
}

fn call_provider(config: &Config, system: &str, user: &str) -> Result<String, String> {
    let base = config.distill.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置模型 baseUrl".into());
    }
    if config.distill.model.trim().is_empty() {
        return Err("未配置模型名称".into());
    }
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    let payload = serde_json::json!({
        "model": config.distill.model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(60))
        .try_proxy_from_env(true)
        .build();
    let mut request = agent.post(&url).set("Content-Type", "application/json");
    if !config.distill.api_key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", config.distill.api_key.trim()));
    }
    let response = request.send_json(payload).map_err(|err| err.to_string())?;
    let value: serde_json::Value = response.into_json().map_err(|err| err.to_string())?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "模型未返回正文".to_string())
}

fn split_title_body(text: &str) -> (String, String) {
    let mut lines = text.lines();
    let first = lines.next().unwrap_or("").trim().trim_start_matches('#').trim().to_string();
    let rest = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if rest.is_empty() {
        let title = crate::util::clip_title(text, "蒸馏草稿");
        return (title, text.trim().to_string());
    }
    let title = if first.is_empty() { crate::util::clip_title(&rest, "蒸馏草稿") } else { first };
    (title.chars().take(60).collect(), rest)
}

/// 管理员侧生成草稿：按作用域分批读取安全材料，记录来源与 expectedRev。
/// 草稿只落库待审核，绝不自动晋升为正式记忆。
pub fn generate_draft(
    conn: &Connection,
    config: &Config,
    scope_kind: &str,
    scope_id: &str,
    actor: &str,
) -> serde_json::Value {
    if config.distill.provider == "none" || config.distill.provider.trim().is_empty() {
        return serde_json::json!({"status": "error", "error": "distill.provider=none：请手工整理正文，或先配置模型提供方。"});
    }
    let scoped: Vec<InboxRecord> = store::inbox_scope_sample(conn, scope_kind, scope_id, 200).unwrap_or_default();
    if scoped.is_empty() {
        return serde_json::json!({"status": "error", "error": "该作用域没有待蒸馏材料"});
    }
    let (safe, blocked) = safe_sources(&scoped);
    if safe.is_empty() {
        return serde_json::json!({"status": "error", "error": "材料全部未通过安全扫描，未发送给模型", "blocked": blocked});
    }
    let used: Vec<&InboxRecord> = scoped
        .iter()
        .filter(|item| !blocked.contains(&item.id))
        .take(MAX_SOURCES)
        .collect();
    let safe_for_prompt: Vec<(String, String)> = used
        .iter()
        .map(|item| {
            let scanned = scan_and_redact(&format!("{}\n{}", item.title, item.body));
            (item.source.clone(), scanned.clean_text)
        })
        .collect();
    let existing = store::list_active_by_scope(conn, scope_kind, scope_id).unwrap_or_default();
    let expected_rev = existing.first().map(|item| item.rev).unwrap_or(0);
    let existing_title = existing.first().map(|item| item.title.clone()).unwrap_or_default();
    let scope_label = if scope_id.is_empty() {
        scope_kind.to_string()
    } else {
        format!("{scope_kind}/{scope_id}")
    };
    let (system, user) = build_prompt(&scope_label, &existing_title, &safe_for_prompt);

    let previous = latest_draft(conn, scope_kind, scope_id).ok().flatten();
    let attempts = previous.as_ref().map(|draft| draft.attempts).unwrap_or(0) + 1;
    if attempts > MAX_ATTEMPTS {
        return serde_json::json!({"status": "error", "error": format!("同一作用域已连续失败 {MAX_ATTEMPTS} 次，请检查配置后手动重试。")});
    }

    let content = match call_provider(config, &system, &user) {
        Ok(content) => content,
        Err(error) => {
            let failed = DistillDraft {
                id: previous.as_ref().map(|draft| draft.id.clone()).unwrap_or_else(|| new_id("dd")),
                scope_kind: scope_kind.into(),
                scope_id: scope_id.into(),
                title: previous.as_ref().map(|draft| draft.title.clone()).unwrap_or_default(),
                body: previous.as_ref().map(|draft| draft.body.clone()).unwrap_or_default(),
                source_ids: used.iter().map(|item| item.id.clone()).collect(),
                source_fingerprints: used.iter().map(|item| source_fingerprint(item)).collect(),
                expected_rev,
                provider: config.distill.provider.clone(),
                model: config.distill.model.clone(),
                status: "failed".into(),
                stale_reason: String::new(),
                error: error.clone(),
                attempts,
                created_at: previous.as_ref().map(|draft| draft.created_at.clone()).unwrap_or_else(now_iso),
                updated_at: now_iso(),
            };
            let _ = upsert_draft(conn, &failed);
            let _ = store::audit(conn, actor, "distill.failed", &format!("{scope_label}: {error}"));
            return serde_json::json!({"status": "failed", "error": error, "attempts": attempts, "blocked": blocked});
        }
    };

    let (title, body) = split_title_body(&content);
    let draft = DistillDraft {
        id: previous.as_ref().map(|draft| draft.id.clone()).unwrap_or_else(|| new_id("dd")),
        scope_kind: scope_kind.into(),
        scope_id: scope_id.into(),
        title: title.clone(),
        body: body.clone(),
        source_ids: used.iter().map(|item| item.id.clone()).collect(),
        source_fingerprints: used.iter().map(|item| source_fingerprint(item)).collect(),
        expected_rev,
        provider: config.distill.provider.clone(),
        model: config.distill.model.clone(),
        status: "pending".into(),
        stale_reason: String::new(),
        error: String::new(),
        attempts,
        created_at: previous.as_ref().map(|draft| draft.created_at.clone()).unwrap_or_else(now_iso),
        updated_at: now_iso(),
    };
    if let Err(error) = upsert_draft(conn, &draft) {
        return serde_json::json!({"status": "error", "error": format!("草稿写入失败：{error}")});
    }
    let _ = store::audit(conn, actor, "distill.draft", &format!("{scope_label} <- {} 条材料", draft.source_ids.len()));
    serde_json::json!({
        "status": "pending",
        "draft": draft,
        "blocked": blocked,
    })
}

/// 来源、rev 或扫描状态变化时把草稿标记为过期，要求重新审核。
pub fn mark_stale_if_changed(conn: &Connection, draft: &DistillDraft) -> rusqlite::Result<Option<String>> {
    let mut reasons: Vec<String> = Vec::new();
    let current = store::list_active_by_scope(conn, &draft.scope_kind, &draft.scope_id)?;
    let current_rev = current.first().map(|item| item.rev).unwrap_or(0);
    if current_rev != draft.expected_rev {
        reasons.push(format!("作用域已更新到 rev {current_rev}"));
    }
    for (index, id) in draft.source_ids.iter().enumerate() {
        match store::get_inbox(conn, id)? {
            None => reasons.push("来源已被处理或删除".into()),
            Some(item) => {
                let expected = draft.source_fingerprints.get(index).cloned().unwrap_or_default();
                if !expected.is_empty() && source_fingerprint(&item) != expected {
                    reasons.push("来源内容已变化".into());
                }
                if item.queue_status != "proposed" {
                    reasons.push("来源状态已变化".into());
                }
            }
        }
        if reasons.len() >= 2 {
            break;
        }
    }
    let reason = reasons.join("；");
    if !reason.is_empty() && draft.status == "pending" {
        let mut next = draft.clone();
        next.status = "stale".into();
        next.stale_reason = reason.clone();
        next.updated_at = now_iso();
        upsert_draft(conn, &next)?;
        return Ok(Some(reason));
    }
    Ok(None)
}

pub fn discard_draft(conn: &Connection, id: &str, actor: &str) -> bool {
    let Ok(Some(draft)) = get_draft(conn, id) else { return false };
    let mut next = draft;
    next.status = "discarded".into();
    next.updated_at = now_iso();
    if upsert_draft(conn, &next).is_err() {
        return false;
    }
    let _ = store::audit(conn, actor, "distill.discard", id);
    true
}

#[cfg(test)]
mod tests {
    use super::{discard_draft, generate_draft, latest_draft, mark_stale_if_changed, tasks};
    use crate::config;
    use crate::db;
    use crate::service::MemoryService;

    fn queue(conn: &rusqlite::Connection, config: &crate::config::Config, body: &str) -> String {
        let result = MemoryService::remember(conn, config, body, None, "cursor", Some("project"), Some("OneLedger"), "collector:cursor", false, None);
        assert_eq!(result["status"], "queued");
        result["inboxId"].as_str().unwrap().to_string()
    }

    #[test]
    fn groups_pending_material_into_tasks_with_high_signal_first() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        queue(&conn, &config, "第一条采集材料");
        queue(&conn, &config, "第二条采集材料");
        let workbuddy = MemoryService::remember(&conn, &config, "WorkBuddy 摘要材料", None, "workbuddy", Some("project"), Some("OneLedger"), "collector:workbuddy", false, None);
        assert_eq!(workbuddy["status"], "queued");
        let items = tasks(&conn).expect("tasks");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].scope_id, "OneLedger");
        assert_eq!(items[0].pending, 3);
        assert_eq!(items[0].high_signal, 1);
        assert_eq!(items[0].sources[0]["source"], "workbuddy");
        assert!(items[0].oldest_waiting_at.is_some());
    }

    #[test]
    fn none_provider_reports_manual_path_and_never_promotes() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue(&conn, &config, "没有模型时也要能手工整理");
        let result = generate_draft(&conn, &config, "project", "OneLedger", "admin");
        assert_eq!(result["status"], "error");
        assert!(result["error"].as_str().unwrap().contains("手工整理"));
        assert!(crate::store::list_active(&conn).expect("active").is_empty());
        let done = MemoryService::confirm_sources(&conn, &config, &[source], "手工整理的整篇", None, "admin", Some(0));
        assert_eq!(done["status"], "stored");
    }

    #[test]
    fn failed_model_call_keeps_sources_and_records_reason() {
        let conn = db::open_db(":memory:").expect("db");
        let mut config = config::default_config();
        config.distill.provider = "openai-compatible".into();
        config.distill.base_url = "http://127.0.0.1:9/never".into();
        config.distill.model = "test-model".into();
        queue(&conn, &config, "模型失败时来源不能丢");
        let result = generate_draft(&conn, &config, "project", "OneLedger", "admin");
        assert_eq!(result["status"], "failed");
        assert!(!result["error"].as_str().unwrap_or("").is_empty());
        assert_eq!(crate::store::list_inbox(&conn).expect("inbox").len(), 1);
        let draft = latest_draft(&conn, "project", "OneLedger").expect("draft").expect("row");
        assert_eq!(draft.status, "failed");
        assert!(!draft.error.is_empty());
        assert_eq!(draft.attempts, 1);
    }

    #[test]
    fn draft_never_reaches_agent_before_review() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue(&conn, &config, "生成草稿用的材料");
        // 手工构造一份待审草稿，模拟模型输出
        let mut draft = crate::distill_job::DistillDraft {
            id: "dd_test".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            title: "草稿标题".into(),
            body: "未经审核的草稿正文".into(),
            source_ids: vec![source.clone()],
            source_fingerprints: vec![],
            expected_rev: 0,
            provider: "openai-compatible".into(),
            model: "stub".into(),
            status: "pending".into(),
            stale_reason: String::new(),
            error: String::new(),
            attempts: 1,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        };
        crate::store::audit(&conn, "admin", "distill.draft", &draft.id).expect("audit");
        draft.source_fingerprints = draft.source_ids.clone();
        assert!(super::upsert_draft(&conn, &draft).is_ok());
        // 未审核：Agent 看不到
        assert!(MemoryService::search(&conn, &config, "未审核的草稿正文", "agent", 8, None, None).is_empty());
        assert!(MemoryService::get(&conn, &config, "agent", None, Some("project"), Some("OneLedger")).is_empty());
        assert!(crate::store::list_active(&conn).expect("active").is_empty());
        // 审核通过后才进入正式记忆
        let done = MemoryService::confirm_sources(&conn, &config, &[source], "未经审核的草稿正文", Some("草稿标题"), "admin", Some(0));
        assert_eq!(done["status"], "stored");
    }

    #[test]
    fn stale_draft_keeps_sources_and_is_refused_on_submit() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue(&conn, &config, "生成草稿的材料");
        let draft = crate::distill_job::DistillDraft {
            id: "dd_stale".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            title: "草稿标题".into(),
            body: "过期草稿正文".into(),
            source_ids: vec![source.clone()],
            source_fingerprints: vec![source.clone()],
            expected_rev: 0,
            provider: "openai-compatible".into(),
            model: "stub".into(),
            status: "pending".into(),
            stale_reason: String::new(),
            error: String::new(),
            attempts: 1,
            created_at: crate::util::now_iso(),
            updated_at: crate::util::now_iso(),
        };
        super::upsert_draft(&conn, &draft).expect("draft");
        let advanced = MemoryService::remember(&conn, &config, "另一个 Agent 更新的正式记忆", None, "mcp:agent", Some("project"), Some("OneLedger"), "agent", false, Some(0));
        assert_eq!(advanced["status"], "stored");
        let reason = mark_stale_if_changed(&conn, &draft).expect("mark").expect("reason");
        assert!(reason.contains("rev"));
        let after = latest_draft(&conn, "project", "OneLedger").expect("draft").expect("row");
        assert_eq!(after.status, "stale");
        assert!(after.body.contains("过期草稿正文"));
        assert_eq!(crate::store::list_inbox(&conn).expect("inbox").len(), 1);
        let conflict = MemoryService::confirm_sources(&conn, &config, &[source], "过期草稿正文", Some("草稿标题"), "admin", Some(0));
        assert_eq!(conflict["status"], "conflict");
        assert_eq!(crate::store::list_active(&conn).expect("active").len(), 1);
    }

    #[test]
    fn discard_keeps_material_pending() {
        let conn = db::open_db(":memory:").expect("db");
        let config = config::default_config();
        let source = queue(&conn, &config, "待废弃草稿的材料");
        let draft = crate::distill_job::DistillDraft {
            id: "dd_discard".into(),
            scope_kind: "project".into(),
            scope_id: "OneLedger".into(),
            title: "草稿".into(),
            body: "正文".into(),
            source_ids: vec![source],
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
        };
        super::upsert_draft(&conn, &draft).expect("draft");
        assert!(discard_draft(&conn, "dd_discard", "admin"));
        let after = latest_draft(&conn, "project", "OneLedger").expect("draft").expect("row");
        assert_eq!(after.status, "discarded");
        assert_eq!(crate::store::list_inbox(&conn).expect("inbox").len(), 1);
    }
}
