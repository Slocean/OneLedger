use crate::collect::{collect_agent, ensure_agents, path_exists, run_collectors_progress, CollectProgress};
use crate::config::{load_config, public_config, save_config, Config};
use crate::service::MemoryService;
use crate::store;
use crate::sync::{apply_remote_memories, authorize_node, sync_with_remote};
use crate::util::{hash_token, new_id, now_iso, safe_equal, APP_VERSION, DATA_SCHEMA_VERSION, PROTOCOL_VERSION};
use crate::vault;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use rusqlite::Connection;
use serde::Deserialize;
#[cfg(feature = "devui")]
use std::collections::{HashMap, VecDeque};
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[derive(RustEmbed)]
#[folder = "web-assets/"]
struct WebAssets; // rebuilt with memory category tabs

/// 开发验收通道：MCP/测试把 DOM 级命令（点击/输入/读取）排队，WebView 内的
/// dev driver 轮询执行后回传结果。仅当 config.devUi = true 且二进制以 `--features devui`
/// 编译时才存在（B-08：正式构建完全不含该通道与路由）；全部端点要求 admin token。
/// 队列有容量上限、命令 TTL 与结果 TTL：窗口未打开时命令过期作废而不是积压，
/// exec 超时会撤销自己排队的命令，结果取走即清，多个调用者互不串扰。
#[cfg(feature = "devui")]
#[derive(Default)]
pub struct DevUiChannel {
    next_id: u64,
    commands: VecDeque<(u64, serde_json::Value, std::time::Instant)>,
    results: HashMap<u64, (serde_json::Value, std::time::Instant)>,
}

#[cfg(feature = "devui")]
impl DevUiChannel {
    const QUEUE_LIMIT: usize = 32;
    const COMMAND_TTL: std::time::Duration = std::time::Duration::from_secs(10);
    const RESULT_TTL: std::time::Duration = std::time::Duration::from_secs(30);

    fn sweep_expired(&mut self) {
        self.commands
            .retain(|(_, _, enqueued)| enqueued.elapsed() < Self::COMMAND_TTL);
        self.results
            .retain(|_id, (_result, at)| at.elapsed() < Self::RESULT_TTL);
    }

    /// 入队一条命令；队列满时返回 None（exec 拒绝而不是无限积压）。
    fn push_command(&mut self, command: serde_json::Value) -> Option<u64> {
        self.sweep_expired();
        if self.commands.len() >= Self::QUEUE_LIMIT {
            return None;
        }
        self.next_id += 1;
        let id = self.next_id;
        self.commands.push_back((id, command, std::time::Instant::now()));
        Some(id)
    }

    fn poll_command(&mut self) -> Option<(u64, serde_json::Value)> {
        self.sweep_expired();
        let (id, command, _) = self.commands.pop_front()?;
        Some((id, command))
    }

    fn cancel_command(&mut self, id: u64) {
        self.commands.retain(|(queued, _, _)| *queued != id);
        self.results.remove(&id);
    }

    fn put_result(&mut self, id: u64, result: serde_json::Value) {
        self.sweep_expired();
        self.results.insert(id, (result, std::time::Instant::now()));
    }

    fn take_result(&mut self, id: u64) -> Option<serde_json::Value> {
        self.sweep_expired();
        self.results.remove(&id).map(|(value, _)| value)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Mutex<Config>>,
    pub conn: Arc<Mutex<Connection>>,
    pub web_dir: PathBuf,
    pub collect: Arc<Mutex<CollectProgress>>,
    pub app_handle: AppHandle,
    pub vault_approval: Arc<Mutex<()>>,
    pub mcp_approval: Arc<Mutex<()>>,
    pub mcp_approved: Arc<Mutex<HashSet<(String, IpAddr)>>>,
    #[cfg(feature = "devui")]
    pub dev_ui: Arc<Mutex<DevUiChannel>>,
}

pub fn start_collect(state: &AppState) {
    {
        let mut progress = state.collect.lock().unwrap();
        if progress.phase == "scanning" {
            return;
        }
        progress.running = true;
        progress.phase = "scanning".into();
        if progress.message.is_empty() {
            progress.message = "正在扫描本地记忆…".into();
        }
    }
    let worker = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = worker.config.lock().unwrap().clone();
        let _ = run_collectors_progress(&worker.conn, &config, &worker.collect);
    });
}

pub fn kick_collect_if_pending(state: &AppState) {
    if state.collect.lock().unwrap().phase == "pending" {
        start_collect(state);
    }
}

fn admin_ok(headers: &HeaderMap, config: &Config) -> bool {
    let token = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| bearer(headers));
    token.is_some_and(|value| safe_equal(&value, &config.admin_token))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "unauthorized" }))).into_response()
}

pub fn router(state: AppState) -> Router {
    let web_dir = state.web_dir.clone();
    let api = {
        let api = Router::new()
            .route("/api/health", get(health))
            .route("/api/status", get(status))
            .route("/api/config", get(get_config).put(put_config))
            .route("/api/memories", get(memories))
            .route("/api/memories/export", get(export_memories))
            .route("/api/backup/export", get(backup_export))
            .route("/api/backup/import", post(backup_import))
            .route("/api/remember", post(remember))
            .route("/api/inbox/:id/reject", post(reject))
            .route("/api/inbox/resolve", post(resolve_inbox))
            .route("/api/version", get(version))
            .route("/api/updates", get(updates))
            .route("/api/updates/download", post(download_update))
            .route("/api/updates/apply", post(apply_update))
            .route("/api/updates/install", post(install_update))
            .route("/api/inbox", get(inbox).post(create_inbox))
            .route("/api/distill/tasks", get(distill_tasks))
            .route("/api/distill/draft", post(distill_draft))
            .route("/api/distill/draft/:id/discard", post(discard_draft))
            .route("/api/scopes/merge/preview", post(scope_merge_preview))
            .route("/api/scopes/merge/confirm", post(scope_merge_confirm))
            .route("/api/scopes/merge/revert", post(scope_merge_revert))
            .route("/api/scopes/merge/operations", get(scope_merge_operations))
            .route("/api/scopes/merge/fingerprint-report", get(scope_merge_fingerprint_report))
            .route("/api/audit", get(audit))
            .route("/api/history/prune", post(prune_history))
            .route("/api/agents", get(agents).post(create_agent))
            .route("/api/agents/:id", put(update_agent).delete(delete_agent))
            .route("/api/agents/:id/collect", post(collect_one))
            .route("/api/collect", post(collect_all))
            .route("/api/sync", post(sync_now))
            .route("/api/keys", get(keys).post(create_key))
            .route("/api/sync/pull", get(sync_pull))
            .route("/api/sync/push", post(sync_push))
            .route("/mcp", get(mcp_get).post(mcp_post));
        // B-08：dev 验收通道只在 `--features devui` 下编入路由；
        // 正式 exe 中这些端点不存在（404 由 axum fallback 处理），不受任何 config 开关影响。
        #[cfg(feature = "devui")]
        let api = api
            .route("/api/dev/ui/poll", get(dev_ui_poll))
            .route("/api/dev/ui/result", post(dev_ui_result))
            .route("/api/dev/ui/exec", post(dev_ui_exec));
        api
    }
    .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
    // B-08：不再使用 permissive CORS。管理台窗口与 API 同源（http://127.0.0.1:port），
    // MCP 客户端与同步节点都不是浏览器，跨站浏览器调用没有合法场景。
    .with_state(state)
    .route("/", get(serve_root))
    .fallback(serve_embedded);
    let _ = web_dir;
    api
}

async fn serve_root() -> Response {
    serve_asset("index.html")
}

async fn serve_embedded(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    serve_asset(if path.is_empty() { "index.html" } else { path })
}

fn serve_asset(path: &str) -> Response {
    match WebAssets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.essence_str())], file.data.to_vec()).into_response()
        }
        None => {
            if path != "index.html" {
                if let Some(file) = WebAssets::get("index.html") {
                    return Html(String::from_utf8_lossy(&file.data).into_owned()).into_response();
                }
            }
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "name": "oneledger",
        "version": APP_VERSION,
        "protocol": PROTOCOL_VERSION,
        "home": crate::config::home_dir()
    }))
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    kick_collect_if_pending(&state);
    let counts = store::counts(&state.conn.lock().unwrap()).unwrap_or(serde_json::json!({}));
    let collect = state.collect.lock().unwrap().snapshot();
    Json(serde_json::json!({
        "version": APP_VERSION,
        "role": config.sync.role,
        "storage": config.storage.driver,
        "bind": format!("{}:{}", config.bind, config.port),
        "counts": counts,
        "collecting": collect.get("running").and_then(|v| v.as_bool()).unwrap_or(false),
        "collect": collect
    }))
    .into_response()
}

async fn get_config(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    Json(public_config(&config)).into_response()
}

async fn put_config(State(state): State<AppState>, headers: HeaderMap, Json(patch): Json<serde_json::Value>) -> Response {
    let current = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &current) {
        return unauthorized();
    }
    let mut next = load_config();
    merge_patch(&mut next, &patch, &current);
    save_config(&next);
    let conn = crate::db::open_db(&next.storage.sqlite_path).expect("reopen db");
    *state.conn.lock().unwrap() = conn;
    *state.config.lock().unwrap() = next.clone();
    Json(serde_json::json!({ "ok": true, "config": public_config(&next) })).into_response()
}

fn merge_patch(next: &mut Config, patch: &serde_json::Value, current: &Config) {
    if let Some(bind) = patch.get("bind").and_then(|v| v.as_str()) {
        next.bind = bind.to_string();
    }
    if let Some(port) = patch.get("port").and_then(|v| v.as_u64()) {
        next.port = port as u16;
    }
    if let Some(storage) = patch.get("storage") {
        if let Ok(partial) = serde_json::from_value::<crate::config::StorageConfig>(storage.clone()) {
            if storage.get("postgresUrl").and_then(|v| v.as_str()).is_some_and(|v| v.contains("****") || v == "(set)") {
                next.storage.postgres_url = current.storage.postgres_url.clone();
                next.storage.driver = partial.driver;
                next.storage.sqlite_path = partial.sqlite_path;
            } else {
                next.storage = partial;
            }
        }
    }
    if let Some(sync) = patch.get("sync") {
        if let Ok(mut partial) = serde_json::from_value::<crate::config::SyncConfig>(sync.clone()) {
            if partial.node_key == "•••• set" {
                partial.node_key = current.sync.node_key.clone();
            }
            next.sync = partial;
        }
    }
    if let Some(collect) = patch.get("collect") {
        if let Ok(partial) = serde_json::from_value::<crate::config::CollectConfig>(collect.clone()) {
            next.collect = partial;
        }
    }
    if let Some(distill) = patch.get("distill") {
        if let Ok(mut partial) = serde_json::from_value::<crate::config::DistillConfig>(distill.clone()) {
            if partial.api_key == "•••• set" {
                partial.api_key = current.distill.api_key.clone();
            }
            next.distill = partial;
        }
    }
    if let Some(security) = patch.get("security") {
        if let Ok(partial) = serde_json::from_value::<crate::config::SecurityConfig>(security.clone()) {
            next.security = partial;
        }
    }
    if let Some(update_url) = patch.get("updateUrl").and_then(|v| v.as_str()) {
        next.update_url = update_url.to_string();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeParams {
    scope_kind: Option<String>,
    scope_id: Option<String>,
}

async fn memories(State(state): State<AppState>, headers: HeaderMap, Query(scope): Query<ScopeParams>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let list = MemoryService::list(&state.conn.lock().unwrap(), 100, scope.scope_kind.as_deref(), scope.scope_id.as_deref());
    Json(serde_json::json!({ "memories": list })).into_response()
}

async fn export_memories(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let memories = MemoryService::list(&state.conn.lock().unwrap(), 10_000, None, None);
    Json(serde_json::json!({
        "name": "oneledger",
        "version": APP_VERSION,
        "exportedAt": crate::util::now_iso(),
        "count": memories.len(),
        "memories": memories
    }))
    .into_response()
}

async fn backup_export(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let backup = {
        let conn = state.conn.lock().unwrap();
        crate::backup::export_backup(&conn)
    };
    match backup {
        Ok(document) => {
            let _ = store::audit(&state.conn.lock().unwrap(), "admin", "backup.export", "full");
            let day = crate::util::now_iso().chars().take(10).collect::<String>().replace('-', "");
            let filename = format!("OneLedger-Backup-{APP_VERSION}-{day}.json");
            let mut response = Json(document).into_response();
            response
                .headers_mut()
                .insert(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\"").parse().unwrap());
            response
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    }
}

async fn backup_import(State(state): State<AppState>, headers: HeaderMap, Json(envelope): Json<serde_json::Value>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let mut conn = state.conn.lock().unwrap();
    match crate::backup::import_backup(&mut conn, &envelope) {
        Ok(report) => {
            let _ = store::audit(&conn, "admin", "backup.import", &serde_json::to_string(&report.applied).unwrap_or_default());
            Json(serde_json::json!({ "ok": true, "applied": report.applied, "skipped": report.skipped })).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberBody {
    body: Option<String>,
    title: Option<String>,
    scope_kind: Option<String>,
    scope_id: Option<String>,
    promote: Option<bool>,
    expected_rev: Option<i64>,
}

async fn remember(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<RememberBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let Some(text) = body.body.filter(|item| !item.trim().is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "body required" }))).into_response();
    };
    let result = MemoryService::remember(
        &state.conn.lock().unwrap(),
        &config,
        &text,
        body.title.as_deref(),
        "ui",
        body.scope_kind.as_deref(),
        body.scope_id.as_deref(),
        "admin",
        body.promote.unwrap_or(false),
        body.expected_rev,
    );
    Json(result).into_response()
}

async fn reject(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let ok = MemoryService::reject_inbox(&state.conn.lock().unwrap(), &id, "admin");
    (if ok { StatusCode::OK } else { StatusCode::NOT_FOUND }, Json(serde_json::json!({ "ok": ok }))).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveInboxBody {
    ids: Vec<String>,
    body: String,
    title: Option<String>,
    expected_rev: Option<i64>,
    draft_id: Option<String>,
}

/// 结构化 5xx：带 request ID，管理员看到的不是“队列为空”而是明确失败（P1-04）。
fn internal_error(error: String) -> Response {
    let request_id = new_id("req");
    eprintln!("oneledger api error [{request_id}]: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "数据读取失败，请重试；若持续出现请把请求 ID 提供给支持", "requestId": request_id })),
    )
        .into_response()
}

async fn resolve_inbox(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ResolveInboxBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    if body.ids.is_empty() || body.body.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ids and body required"}))).into_response();
    }
    let conn = state.conn.lock().unwrap();
    let result = MemoryService::confirm_sources(
        &conn,
        &config,
        &body.ids,
        &body.body,
        body.title.as_deref(),
        "admin",
        body.expected_rev,
        body.draft_id.as_deref(),
    );
    Json(result).into_response()
}

async fn version() -> impl IntoResponse {
    Json(serde_json::json!({
        "version": APP_VERSION,
        "protocol": PROTOCOL_VERSION,
        "dataSchema": DATA_SCHEMA_VERSION
    }))
}

async fn updates(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let url = config.update_url.clone();
    match tokio::task::spawn_blocking(move || crate::update::check(&url)).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn download_update(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let url = config.update_url.clone();
    match tokio::task::spawn_blocking(move || crate::update::download(&url)).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn apply_update(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    match tokio::task::spawn_blocking(crate::update::apply).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn install_update(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let url = config.update_url.clone();
    match tokio::task::spawn_blocking(move || crate::update::install(&url)).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn create_inbox(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<RememberBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let Some(text) = body.body.filter(|item| !item.trim().is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "body required" }))).into_response();
    };
    let result = MemoryService::remember(
        &state.conn.lock().unwrap(),
        &config,
        &text,
        body.title.as_deref(),
        "custom",
        None,
        None,
        "admin",
        false,
        None,
    );
    Json(result).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxParams {
    status: Option<String>,
    scope_kind: Option<String>,
    scope_id: Option<String>,
    source: Option<String>,
    ids: Option<String>,
    /// B-04：按 ID 查询必须携带草稿 ID 以证明关联；缺失或对不上时不返回任何正文。
    draft_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn inbox(State(state): State<AppState>, headers: HeaderMap, Query(params): Query<InboxParams>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let rejected = params.status.as_deref() == Some("rejected");
    let status = if rejected { "rejected" } else { "proposed" };
    let limit = params.limit.unwrap_or(50).clamp(1, 100);
    let offset = params.offset.unwrap_or(0).max(0);
    let conn = state.conn.lock().unwrap();
    // 按精确 ID 集合取材料：只服务草稿审核（B-04）。
    // 请求必须携带能证明关联的 draftId，且每个 ID 都登记在该待审草稿的来源清单里；
    // 任何对不上（草稿不存在/已不可审核/ID 不在草稿里/作用域漂移）都返回错误，绝不回退到
    // 返回行正文。脱敏一律按实际 queue_status 判定，不信任客户端传来的 status 参数。
    if let Some(ids_raw) = params.ids.as_deref().filter(|item| !item.is_empty()) {
        let Some(draft_id) = params.draft_id.as_deref().filter(|item| !item.is_empty()) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "按 ID 查询材料仅供草稿审核使用：缺少 draftId" })),
            )
                .into_response();
        };
        let ids: Vec<String> = ids_raw.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_string).collect();
        if ids.is_empty() || ids.len() > 100 {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "ids 一次最多 100 条" }))).into_response();
        }
        let Some(draft) = crate::distill_job::get_draft(&conn, draft_id).ok().flatten() else {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "草稿不存在或已删除" }))).into_response();
        };
        if draft.status != "pending" {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": format!("草稿状态为 {}，已不可审核", draft.status) })),
            )
                .into_response();
        }
        let draft_set: std::collections::HashSet<&String> = draft.source_ids.iter().collect();
        if ids.iter().any(|id| !draft_set.contains(id)) {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "请求的材料不在该草稿的来源清单中，请重新打开草稿审核" })),
            )
                .into_response();
        }
        let items = match store::inbox_by_ids(&conn, &ids) {
            Ok(items) => items,
            Err(error) => return internal_error(format!("inbox_by_ids: {error}")),
        };
        if items
            .iter()
            .any(|item| item.scope_kind != draft.scope_kind || item.scope_id != draft.scope_id)
        {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "材料作用域与草稿不一致（可能已被移动或处理），请重新核对草稿" })),
            )
                .into_response();
        }
        let safe_items: Vec<serde_json::Value> = items
            .into_iter()
            .map(|mut item| {
                if item.queue_status == "rejected" {
                    item.title = "已拒收材料".into();
                    item.body = "[REDACTED:rejected]".into();
                }
                serde_json::to_value(item).unwrap_or_default()
            })
            .collect();
        return Json(serde_json::json!({ "inbox": safe_items, "total": safe_items.len(), "limit": safe_items.len(), "offset": 0, "hasMore": false }))
            .into_response();
    }
    let (items, total) = match store::inbox_page(
        &conn,
        status,
        params.scope_kind.as_deref(),
        params.scope_id.as_deref(),
        params.source.as_deref(),
        limit,
        offset,
    ) {
        Ok(page) => page,
        Err(error) => return internal_error(format!("inbox_page: {error}")),
    };
    let safe_items: Vec<serde_json::Value> = {
        // 一次批量取回本页材料的命中规则，避免每行一次 redaction_events 查询（N+1）。
        // 命中规则是审核的安全状态，读取失败必须显式失败，不能伪装成“无命中”。
        let ids_json = serde_json::to_string(&items.iter().map(|item| item.id.clone()).collect::<Vec<_>>())
            .unwrap_or_else(|_| "[]".into());
        let hits_result: Result<std::collections::HashMap<String, Vec<String>>, rusqlite::Error> = (|| {
            let mut stmt = conn.prepare(
                "SELECT inbox_id, hit_type FROM redaction_events WHERE inbox_id IN (SELECT value FROM json_each(?1)) ORDER BY inbox_id, hit_type",
            )?;
            let rows = stmt.query_map([&ids_json], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            for row in rows {
                let (inbox_id, hit_type) = row?;
                map.entry(inbox_id).or_default().push(hit_type);
            }
            Ok(map)
        })();
        let mut hits_map = match hits_result {
            Ok(map) => map,
            Err(error) => return internal_error(format!("redaction hits: {error}")),
        };
        items.into_iter().map(|mut item| {
            let hits = hits_map.remove(&item.id).unwrap_or_default();
            if rejected {
                item.title = "已拒收材料".into();
                item.body = "[REDACTED:rejected]".into();
            }
            let mut value = serde_json::to_value(item).unwrap_or_default();
            value["hits"] = serde_json::json!(hits);
            value
        }).collect()
    };
    let has_more = offset + (safe_items.len() as i64) < total;
    Json(serde_json::json!({
        "inbox": safe_items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": has_more,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DistillScopeBody {
    scope_kind: String,
    scope_id: Option<String>,
    source_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct DistillTasksParams {
    query: Option<String>,
    abnormal: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn distill_tasks(State(state): State<AppState>, headers: HeaderMap, Query(params): Query<DistillTasksParams>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    // 审核前刷新草稿过期状态：这是审核安全状态，刷新失败必须显式失败，
    // 不能把“草稿是否过期未知”伪装成正常返回（P1-04）。
    let drafts = match crate::distill_job::pending_drafts(&conn) {
        Ok(drafts) => drafts,
        Err(error) => return internal_error(format!("pending_drafts: {error}")),
    };
    for draft in drafts.iter().take(50) {
        if let Err(error) = crate::distill_job::mark_stale_if_changed(&conn, draft) {
            return internal_error(format!("mark_stale_if_changed: {error}"));
        }
    }
    let limit = params.limit.unwrap_or(30).clamp(1, 100);
    let offset = params.offset.unwrap_or(0).max(0);
    let only_abnormal = matches!(params.abnormal.as_deref(), Some("1") | Some("true"));
    let (items, total) = match crate::distill_job::tasks_page(&conn, params.query.as_deref().unwrap_or(""), only_abnormal, limit, offset) {
        Ok(page) => page,
        Err(error) => return internal_error(format!("tasks_page: {error}")),
    };
    let has_more = offset + (items.len() as i64) < total;
    Json(serde_json::json!({
        "tasks": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": has_more,
        "provider": config.distill.provider,
        "model": config.distill.model,
    }))
    .into_response()
}

async fn distill_draft(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<DistillScopeBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let scope_id = body.scope_id.unwrap_or_default();
    let source_ids = body.source_ids.unwrap_or_default();
    let conn = state.conn.lock().unwrap();
    let result = crate::distill_job::generate_draft(&conn, &config, &body.scope_kind, &scope_id, &source_ids, "admin");
    Json(result).into_response()
}

async fn discard_draft(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let ok = crate::distill_job::discard_draft(&state.conn.lock().unwrap(), &id, "admin");
    (if ok { StatusCode::OK } else { StatusCode::NOT_FOUND }, Json(serde_json::json!({ "ok": ok }))).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeMergeBody {
    from_scope_kind: String,
    from_scope_id: String,
    to_scope_id: String,
    digest: Option<String>,
    /// B-07：管理员显式勾选、经核对的精确 ID 子集；确认只移动这批 ID。
    ids: Option<Vec<String>>,
}

async fn scope_merge_preview(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ScopeMergeBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    match crate::scope_merge::preview(&conn, &body.from_scope_kind, &body.from_scope_id, &body.to_scope_id) {
        Ok(preview) => Json(preview).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "status": "error", "error": error }))).into_response(),
    }
}

async fn scope_merge_confirm(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<ScopeMergeBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let Some(digest) = body.digest.as_deref().filter(|item| !item.is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "status": "error", "error": "缺少预览摘要 digest，请先预览" }))).into_response();
    };
    let empty: Vec<String> = Vec::new();
    let selected = body.ids.as_deref().unwrap_or(&empty);
    let conn = state.conn.lock().unwrap();
    let result = crate::scope_merge::confirm(&conn, &body.from_scope_kind, &body.from_scope_id, &body.to_scope_id, digest, selected, "admin");
    let status = result["status"].as_str().unwrap_or("error");
    let code = match status {
        "applied" | "conflict" | "blocked" => StatusCode::OK,
        _ => StatusCode::BAD_REQUEST,
    };
    (code, Json(result)).into_response()
}

async fn scope_merge_revert(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let Some(operation_id) = body.get("operationId").and_then(|v| v.as_str()).filter(|item| !item.is_empty()) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "status": "error", "error": "operationId required" }))).into_response();
    };
    let conn = state.conn.lock().unwrap();
    let result = crate::scope_merge::revert(&conn, operation_id, "admin");
    let status = result["status"].as_str().unwrap_or("error");
    let code = match status {
        "reverted" | "already-reverted" | "conflict" => StatusCode::OK,
        _ => StatusCode::BAD_REQUEST,
    };
    (code, Json(result)).into_response()
}

async fn scope_merge_operations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let limit = params.get("limit").and_then(|v| v.parse::<i64>().ok()).unwrap_or(20).clamp(1, 100);
    let offset = params.get("offset").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0).max(0);
    let conn = state.conn.lock().unwrap();
    let result = crate::scope_merge::list_operations(&conn, limit, offset);
    if result.get("error").is_some() {
        return internal_error(result["error"].as_str().unwrap_or("list operations failed").to_string());
    }
    Json(result).into_response()
}

async fn scope_merge_fingerprint_report(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    match crate::scope_merge::fingerprint_damage_report(&conn) {
        Ok(report) => Json(report).into_response(),
        Err(error) => internal_error(format!("fingerprint report: {error}")),
    }
}

#[cfg(feature = "devui")]
fn dev_ui_enabled(config: &Config) -> bool {
    config.dev_ui
}

/// WebView 内 dev driver 轮询取命令。dev 关闭时 404，前端据此静默停用。
#[cfg(feature = "devui")]
async fn dev_ui_poll(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    if !dev_ui_enabled(&config) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let command = state
        .dev_ui
        .lock()
        .unwrap()
        .poll_command()
        .map(|(id, command)| serde_json::json!({ "commandId": id, "command": command }))
        .unwrap_or(serde_json::json!({}));
    Json(command).into_response()
}

#[cfg(feature = "devui")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevUiResultBody {
    command_id: u64,
    #[serde(flatten)]
    result: serde_json::Value,
}

#[cfg(feature = "devui")]
async fn dev_ui_result(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<DevUiResultBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    if !dev_ui_enabled(&config) {
        return StatusCode::NOT_FOUND.into_response();
    }
    state.dev_ui.lock().unwrap().put_result(body.command_id, body.result);
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// 同步执行一条 DOM 命令：入队 → 等待 WebView 内 dev driver 回传结果（最多 6 秒）。
/// 超时会撤销自己排队的命令（B-08）：命令不会在调用方已收到超时之后才被执行，
/// 结果也不会滞留在内存里。
#[cfg(feature = "devui")]
async fn dev_ui_exec(State(state): State<AppState>, headers: HeaderMap, Json(command): Json<serde_json::Value>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    if !dev_ui_enabled(&config) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "devUi 未启用：隔离验收需在 config.json 设置 devUi=true，且二进制须以 --features devui 编译" })),
        )
            .into_response();
    }
    let command_id = match state.dev_ui.lock().unwrap().push_command(command) {
        Some(id) => id,
        None => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({ "error": "dev 命令队列已满（窗口可能未打开），请稍后重试" })),
            )
                .into_response()
        }
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        {
            let mut channel = state.dev_ui.lock().unwrap();
            if let Some(result) = channel.take_result(command_id) {
                return Json(serde_json::json!({ "commandId": command_id, "result": result })).into_response();
            }
        }
        if std::time::Instant::now() >= deadline {
            state.dev_ui.lock().unwrap().cancel_command(command_id);
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({ "commandId": command_id, "error": "dev driver 未在 6 秒内回传结果（窗口可能未打开或未登录）；命令已撤销" })),
            )
                .into_response();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

async fn audit(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    Json(serde_json::json!({
        "audit": store::list_audit(&conn).unwrap_or_default(),
        "redactions": store::list_redactions(&conn).unwrap_or_default()
    }))
    .into_response()
}

async fn prune_history(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    match store::prune_history(&state.conn.lock().unwrap()) {
        Ok((events, rejected)) => Json(serde_json::json!({"ok": true, "archivedEvents": events, "removedRejected": rejected})).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "history cleanup failed"}))).into_response(),
    }
}

async fn agents(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    let _ = ensure_agents(&conn, &config);
    let agents: Vec<serde_json::Value> = store::list_agents(&conn)
        .unwrap_or_default()
        .into_iter()
        .map(|agent| {
            let mut value = serde_json::to_value(&agent).unwrap_or_default();
            value["pathExists"] = serde_json::json!(path_exists(&agent.root_path));
            value
        })
        .collect();
    Json(serde_json::json!({ "agents": agents })).into_response()
}

#[derive(Deserialize)]
struct AgentBody {
    name: Option<String>,
    #[serde(rename = "rootPath")]
    root_path: Option<String>,
    enabled: Option<bool>,
}

async fn create_agent(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<AgentBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let (Some(name), Some(root_path)) = (body.name.filter(|s| !s.trim().is_empty()), body.root_path.filter(|s| !s.trim().is_empty())) else {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "name and rootPath required" }))).into_response();
    };
    let record = crate::models::AgentRecord {
        id: new_id("ag"),
        name: name.trim().into(),
        kind: "custom".into(),
        builtin: false,
        enabled: true,
        root_path: root_path.trim().into(),
        last_scanned_at: None,
        last_scanned_files: 0,
        last_ingested: 0,
        last_queued: 0,
        last_redacted: 0,
        last_error: String::new(),
        created_at: now_iso(),
    };
    let conn = state.conn.lock().unwrap();
    let _ = store::upsert_agent(&conn, &record);
    let _ = store::audit(&conn, "admin", "agent.create", &record.id);
    let mut value = serde_json::to_value(&record).unwrap_or_default();
    value["pathExists"] = serde_json::json!(path_exists(&record.root_path));
    Json(serde_json::json!({ "agent": value })).into_response()
}

async fn update_agent(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<AgentBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    let Some(mut current) = store::get_agent(&conn, &id).ok().flatten() else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response();
    };
    if let Some(enabled) = body.enabled {
        current.enabled = enabled;
    }
    if let Some(root) = body.root_path.filter(|s| !s.trim().is_empty()) {
        current.root_path = root.trim().into();
    }
    if let Some(name) = body.name.filter(|s| !s.trim().is_empty()) {
        current.name = name.trim().into();
    }
    let _ = store::upsert_agent(&conn, &current);
    let mut value = serde_json::to_value(&current).unwrap_or_default();
    value["pathExists"] = serde_json::json!(path_exists(&current.root_path));
    Json(serde_json::json!({ "agent": value })).into_response()
}

async fn delete_agent(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    let Some(current) = store::get_agent(&conn, &id).ok().flatten() else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response();
    };
    if current.builtin {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "builtin agents cannot be deleted" }))).into_response();
    }
    let _ = store::delete_agent(&conn, &current.id);
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn collect_one(State(state): State<AppState>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let conn = state.conn.lock().unwrap();
    let Some(current) = store::get_agent(&conn, &id).ok().flatten() else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))).into_response();
    };
    let result = collect_agent(&conn, &MemoryService, current);
    Json(serde_json::json!({ "result": result, "agent": store::get_agent(&conn, &id).ok().flatten() })).into_response()
}

async fn collect_all(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    if state.collect.lock().unwrap().phase == "scanning" {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "collecting",
                "collect": state.collect.lock().unwrap().snapshot()
            })),
        )
            .into_response();
    }
    let worker = state.clone();
    let results = tokio::task::spawn_blocking(move || {
        run_collectors_progress(&worker.conn, &config, &worker.collect)
    })
    .await
    .unwrap_or_default();
    Json(serde_json::json!({ "results": results })).into_response()
}

async fn sync_now(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    Json(sync_with_remote(&state.conn.lock().unwrap(), &config)).into_response()
}

async fn keys(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let keys: Vec<serde_json::Value> = store::list_keys(&state.conn.lock().unwrap())
        .unwrap_or_default()
        .into_iter()
        .map(|key| {
            serde_json::json!({
                "id": key.id,
                "name": key.name,
                "tokenPrefix": key.token_prefix,
                "tools": key.tools,
                "createdAt": key.created_at,
                "lastUsedAt": key.last_used_at,
                "recoverable": key.protected_token.is_some()
            })
        })
        .collect();
    Json(serde_json::json!({ "keys": keys })).into_response()
}

#[derive(Deserialize)]
struct KeyBody {
    name: Option<String>,
}

async fn create_key(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<KeyBody>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    match MemoryService::issue_key(&state.conn.lock().unwrap(), body.name.as_deref().unwrap_or("agent")) {
        Ok(issued) => Json(issued).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
struct PullQuery {
    since: Option<String>,
}

async fn sync_pull(State(state): State<AppState>, headers: HeaderMap, Query(query): Query<PullQuery>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !authorize_node(&config, headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())) {
        return unauthorized();
    }
    let proto = headers
        .get("x-oneledger-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(1);
    if proto != PROTOCOL_VERSION {
        return (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "protocol mismatch" }))).into_response();
    }
    let since = query.since.unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());
    let memories: Vec<_> = store::changed_since(&state.conn.lock().unwrap(), &since)
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.sensitivity != "secret")
        .collect();
    Json(serde_json::json!({ "memories": memories })).into_response()
}

async fn sync_push(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !authorize_node(&config, headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())) {
        return unauthorized();
    }
    let memories = serde_json::from_value(body.get("memories").cloned().unwrap_or(serde_json::json!([]))).unwrap_or_default();
    let applied = apply_remote_memories(&state.conn.lock().unwrap(), memories);
    Json(serde_json::json!({ "applied": applied })).into_response()
}

async fn mcp_get() -> impl IntoResponse {
    Json(serde_json::json!({}))
}

async fn mcp_post(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(payload): Json<serde_json::Value>) -> Response {
    let config = state.config.lock().unwrap().clone();
    let Some(token) = bearer(&headers) else {
        return unauthorized();
    };
    let (key_id, name, tools) = {
        let conn = state.conn.lock().unwrap();
        let Some(key) = store::find_key_by_hash(&conn, &hash_token(&token)).ok().flatten() else {
            return unauthorized();
        };
        (key.id, key.name, key.tools)
    };
    let request_id = payload.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let response = tokio::task::spawn_blocking(move || {
        approve_mcp_connection(&state, &key_id, &name, peer.ip())?;
        let _ = store::touch_key(&state.conn.lock().unwrap(), &key_id);
        Ok::<_, String>(handle_mcp(&state, &config, &name, &tools, payload))
    }).await;
    match response {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(error)) => (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": error }))).into_response(),
        Err(_) => Json(serde_json::json!({ "jsonrpc": "2.0", "id": request_id, "error": { "code": -32603, "message": "MCP 处理失败" } })).into_response(),
    }
}

fn approve_mcp_connection(state: &AppState, key_id: &str, name: &str, source: IpAddr) -> Result<(), String> {
    {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        if store::mcp_source_trusted(&conn, key_id, &source.to_string()).map_err(|_| "无法读取记住的连接".to_string())? {
            return Ok(());
        }
    }
    let identity = (key_id.to_string(), source);
    approve_once(&state.mcp_approval, &state.mcp_approved, identity, || {
        let window = vault::agent_window(state)?;
        let visible_name: String = name.chars().filter(|ch| !ch.is_control()).take(60).collect();
        let remembered = vault::confirm_with_remember(
            &window,
            "OneLedger MCP 连接确认",
            &format!("Agent 密钥「{visible_name}」请求从 {source} 连接 OneLedger。\n是否同意？"),
            &format!("记住此设备：这把密钥从 {source} 连接不再询问（可在 MCP 密钥页撤销）"),
        )?;
        if remembered {
            let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
            store::trust_mcp_source(&conn, key_id, &source.to_string()).map_err(|_| "无法记住此设备".to_string())?;
            let _ = store::audit(&conn, "admin", "mcp.trust_source", &format!("{key_id} {source}"));
        }
        Ok(())
    })
}

fn approve_once<F>(gate: &Mutex<()>, approved: &Mutex<HashSet<(String, IpAddr)>>, identity: (String, IpAddr), confirm: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    if approved.lock().map_err(|_| "连接确认不可用".to_string())?.contains(&identity) {
        return Ok(());
    }
    let _approval = gate.lock().map_err(|_| "连接确认不可用".to_string())?;
    if approved.lock().map_err(|_| "连接确认不可用".to_string())?.contains(&identity) {
        return Ok(());
    }
    confirm()?;
    approved.lock().map_err(|_| "连接确认不可用".to_string())?.insert(identity);
    Ok(())
}

fn tool_allowed(tools: &str, name: &str) -> bool {
    let permitted: Vec<&str> = tools.split(',').map(str::trim).filter(|item| !item.is_empty()).collect();
    if matches!(name, "memory.search" | "memory.remember" | "memory.forget" | "memory.list" | "memory.get" | "memory.export" | "memory.import" | "vault.list" | "vault.put" | "vault.organize" | "vault.delete") && permitted.contains(&name) {
        return true;
    }
    match name {
        "memory.get" | "memory.export" | "vault.list" => permitted.contains(&"memory.list") || permitted.contains(&"memory.search"),
        "memory.import" | "vault.put" | "vault.organize" => permitted.contains(&"memory.remember"),
        "vault.delete" => permitted.contains(&"memory.forget"),
        _ => false,
    }
}

#[cfg(test)]
mod vault_permission_tests {
    use super::{approve_once, tool_allowed};
    use std::collections::HashSet;
    use std::sync::Mutex;

    #[cfg(feature = "devui")]
    #[test]
    fn dev_ui_channel_queues_commands_and_returns_results() {
        use super::DevUiChannel;
        let mut channel = DevUiChannel::default();
        let id = channel.push_command(serde_json::json!({ "kind": "click", "text": "审核" })).expect("queue not full");
        assert_eq!(id, 1);
        assert!(channel.poll_command().is_some());
        assert!(channel.poll_command().is_none(), "queue must drain");
        channel.put_result(id, serde_json::json!({ "ok": true }));
        let result = channel.take_result(id).expect("result");
        assert_eq!(result["ok"], true);
        assert!(channel.take_result(id).is_none(), "result must be consumed once");
    }

    /// B-08：命令队列有容量上限；exec 超时撤销后，队列里的命令不能再被执行。
    #[cfg(feature = "devui")]
    #[test]
    fn dev_ui_channel_has_capacity_limit_and_cancel() {
        use super::DevUiChannel;
        let mut channel = DevUiChannel::default();
        for index in 0..DevUiChannel::QUEUE_LIMIT {
            assert!(channel.push_command(serde_json::json!({ "n": index })).is_some());
        }
        assert!(channel.push_command(serde_json::json!({ "n": "overflow" })).is_none(), "queue must refuse when full");
        let first_id = 1;
        channel.cancel_command(first_id);
        let polled = channel.poll_command().expect("remaining command");
        assert_ne!(polled.0, first_id, "cancelled command must not be delivered");
    }

    #[test]
    fn vault_permissions_follow_existing_key_scopes_and_never_expose_reveal() {
        let read = "memory.search,memory.list";
        assert!(tool_allowed(read, "vault.list"));
        assert!(tool_allowed(read, "memory.export"));
        assert!(!tool_allowed(read, "memory.import"));
        assert!(!tool_allowed(read, "vault.put"));
        assert!(!tool_allowed(read, "vault.organize"));
        assert!(!tool_allowed(read, "vault.delete"));

        let write = "memory.remember,memory.forget";
        assert!(tool_allowed(write, "memory.import"));
        assert!(tool_allowed(write, "vault.put"));
        assert!(tool_allowed(write, "vault.organize"));
        assert!(tool_allowed(write, "vault.delete"));
        assert!(!tool_allowed(write, "vault.list"));
        assert!(!tool_allowed("memory.search,memory.remember,memory.forget,vault.reveal", "vault.reveal"));
    }

    #[test]
    fn mcp_connection_requires_approval_once_per_key_and_source() {
        let gate = Mutex::new(());
        let approved = Mutex::new(HashSet::new());
        let local = ("key_a".to_string(), "127.0.0.1".parse().expect("ip"));
        assert!(approve_once(&gate, &approved, local.clone(), || Err("denied".into())).is_err());
        assert!(!approved.lock().unwrap().contains(&local));
        approve_once(&gate, &approved, local.clone(), || Ok(())).expect("approve");
        approve_once(&gate, &approved, local.clone(), || panic!("approved connection prompted again")).expect("reuse");
        let other_source = ("key_a".to_string(), "192.168.0.2".parse().expect("ip"));
        assert!(approve_once(&gate, &approved, other_source.clone(), || Err("denied".into())).is_err());
        assert!(!approved.lock().unwrap().contains(&other_source));
    }
}

fn counts_summary(counts: &serde_json::Map<String, serde_json::Value>) -> String {
    const LABELS: &[(&str, &str)] = &[
        ("memories", "记忆"),
        ("inbox", "收件箱"),
        ("vaultItems", "凭据密文"),
        ("apiKeys", "Agent 密钥"),
        ("agents", "采集源"),
        ("redactionEvents", "脱敏记录"),
        ("redactionArchive", "脱敏归档"),
        ("collectFingerprints", "采集指纹"),
        ("distillDrafts", "蒸馏草稿"),
        ("trustedMcpSources", "记住的连接"),
    ];
    let parts: Vec<String> = LABELS
        .iter()
        .filter_map(|(key, label)| counts.get(*key).map(|count| format!("{label} {}", count)))
        .collect();
    if parts.is_empty() {
        "空备份".into()
    } else {
        parts.join("、")
    }
}

fn handle_mcp(state: &AppState, config: &Config, actor: &str, tools: &str, payload: serde_json::Value) -> serde_json::Value {
    let id = payload.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = payload.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let tool_ok = |name: &str| tool_allowed(tools, name);
    match method {
        "initialize" => {
            let project_scope = payload["params"]["projectScopeId"].as_str()
                .filter(|value| !value.is_empty() && !value.contains('/') && !value.contains('\\'));
            let index = if tool_ok("memory.list") || tool_ok("memory.search") {
                let conn = state.conn.lock().unwrap();
                let mut items = store::list_memories(&conn, 12, Some("global"), None).unwrap_or_default();
                if let Some(scope) = project_scope {
                    items.extend(store::list_memories(&conn, 12, Some("project"), Some(scope)).unwrap_or_default());
                }
                items.into_iter()
                    .filter(|item| item.sensitivity == "public" || (item.sensitivity == "internal" && config.security.allow_internal_in_search))
                    .map(|item| format!("{}:{} [{} rev {}]", item.scope_kind, item.scope_id, item.title, item.rev))
                    .collect::<Vec<_>>()
                    .join("; ")
            } else {
                String::new()
            };
            let instructions = format!("OneLedger stores distilled scope documents. At task start, call memory.get with scopeKind=project and scopeId=repository name, plus global if useful. Read rev before replacing a scope and pass expectedRev to memory.remember. Vault tools list metadata and propose changes; ask the user first, then wait for desktop approval. Vault tools never return stored raw values. Available index: {index}");
            serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "oneledger", "version": APP_VERSION },
                "instructions": instructions
            }
        })
        },
        "notifications/initialized" | "ping" => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => {
            let all = [
                ("memory.search", "Search durable shared memories. Results never include secret-classified text. Filter with scopeKind and scopeId (repository name).", serde_json::json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"number"},"scopeKind":{"type":"string","enum":["global","project","personal"]},"scopeId":{"type":"string"}},"required":["query"]})),
                ("memory.remember", "Replace the distilled write-up for this scope. Read the current rev first and pass expectedRev to protect concurrent edits. Same scope overwrites the previous document. OneLedger does not summarize.", serde_json::json!({"type":"object","properties":{"body":{"type":"string"},"title":{"type":"string"},"scopeKind":{"type":"string"},"scopeId":{"type":"string"},"expectedRev":{"type":"integer"}},"required":["body"]})),
                ("memory.forget", "Remove an official distilled memory so it is no longer recalled.", serde_json::json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]})),
                ("memory.list", "List memory titles only, without bodies. Includes scopeId. Filter with scopeKind and scopeId.", serde_json::json!({"type":"object","properties":{"limit":{"type":"number"},"scopeKind":{"type":"string","enum":["global","project","personal"]},"scopeId":{"type":"string"}}})),
                ("memory.get", "Read full distilled documents. Pass id, or scopeKind and/or scopeId (repository name). No dummy search query. Results never include secret-classified text.", serde_json::json!({"type":"object","properties":{"id":{"type":"string"},"scopeKind":{"type":"string","enum":["global","project","personal"]},"scopeId":{"type":"string"}}})),
                ("memory.export", "Export a portable backup of this ledger as one JSON document (kind oneledger-backup). Carries the shareable memory subset: no secret/pii rows, no inbox, no vault ciphertext, no key material. Save the returned text as a .json file; import it later with memory.import or the desktop console.", serde_json::json!({"type":"object","properties":{}})),
                ("memory.import", "Import a OneLedger backup previously produced by memory.export or the desktop console. Pass the parsed file content as data. Merge semantics: rows are matched by id, memories only overwrite older revisions, local rows absent from the file are kept. Requires explicit desktop approval.", serde_json::json!({"type":"object","properties":{"data":{"type":"object","description":"The parsed JSON content of the backup file"}},"required":["data"]})),
                ("vault.list", "List local vault metadata only. Never returns stored values. Use limit and offset to page; filter by scopeKind and scopeId when useful.", serde_json::json!({"type":"object","properties":{"scopeKind":{"type":"string","enum":["global","project","personal"]},"scopeId":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200},"offset":{"type":"integer","minimum":0}}})),
                ("vault.put", "Propose saving or replacing a raw value. Ask the user first; OneLedger requires explicit desktop approval. The value is present in this tool call and must not be repeated in other tools or logs. To replace, pass id and expectedUpdatedAt from vault.list. Returns metadata only.", serde_json::json!({"type":"object","properties":{"id":{"type":"string"},"label":{"type":"string"},"scopeKind":{"type":"string","enum":["global","project","personal"]},"scopeId":{"type":"string"},"value":{"type":"string"},"expectedUpdatedAt":{"type":"string"}},"required":["label","scopeKind","scopeId","value"]})),
                ("vault.organize", "Propose renaming or moving a vault item without reading or changing its stored value. Ask the user first; desktop approval is required. Pass id and expectedUpdatedAt from vault.list.", serde_json::json!({"type":"object","properties":{"id":{"type":"string"},"label":{"type":"string"},"scopeKind":{"type":"string","enum":["global","project","personal"]},"scopeId":{"type":"string"},"expectedUpdatedAt":{"type":"string"}},"required":["id","label","scopeKind","scopeId","expectedUpdatedAt"]})),
                ("vault.delete", "Propose permanently deleting a vault item. Ask the user first; desktop approval is required. Pass id and expectedUpdatedAt from vault.list.", serde_json::json!({"type":"object","properties":{"id":{"type":"string"},"expectedUpdatedAt":{"type":"string"}},"required":["id","expectedUpdatedAt"]})),
            ];
            let tools: Vec<serde_json::Value> = all
                .into_iter()
                .filter(|(name, _, _)| tool_ok(name))
                .map(|(name, desc, schema)| serde_json::json!({"name": name, "description": desc, "inputSchema": schema}))
                .collect();
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })
        }
        "tools/call" => {
            let name = payload["params"]["name"].as_str().unwrap_or("");
            if !tool_ok(name) {
                return serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "tool not allowed" } });
            }
            let args = payload["params"]["arguments"].clone();
            if name == "memory.import" {
                let envelope = args.get("data").cloned().unwrap_or(serde_json::Value::Null);
                let outcome: Result<serde_json::Value, String> = (|| {
                    let counts = crate::backup::summarize(&envelope)?;
                    let _approval = state.vault_approval.lock().map_err(|_| "确认窗口不可用".to_string())?;
                    let window = vault::agent_window(state)?;
                    let summary = counts_summary(&counts);
                    vault::confirm_with_title(
                        &window,
                        "OneLedger 备份导入确认",
                        &format!("Agent「{actor}」请求导入备份数据（{summary}）。\n按 id 合并：记忆仅当文件里的版本更新时覆盖，本地多出的数据保留。\n是否同意？"),
                    )?;
                    let mut conn = state.conn.lock().unwrap();
                    let report = crate::backup::import_backup(&mut conn, &envelope)?;
                    let _ = store::audit(&conn, &format!("mcp:{actor}"), "memory.import", &serde_json::to_string(&report.applied).unwrap_or_default());
                    Ok(serde_json::json!({ "status": "imported", "applied": report.applied, "skipped": report.skipped }))
                })();
                let is_error = outcome.is_err();
                let body = outcome.unwrap_or_else(|error| serde_json::json!({ "status": "rejected", "error": error }));
                return serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": serde_json::to_string(&body).unwrap_or_default() }], "isError": is_error } });
            }
            if name.starts_with("vault.") {                let result: Result<serde_json::Value, String> = match name {
                    "vault.list" => {
                        let limit = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
                        let offset = args["offset"].as_i64().unwrap_or(0).max(0);
                        vault::agent_list(state, actor, args["scopeKind"].as_str(), args["scopeId"].as_str(), limit, offset)
                            .map(|items| {
                                let next_offset = if items.len() == limit as usize { Some(offset.saturating_add(limit)) } else { None };
                                serde_json::json!({ "items": items, "nextOffset": next_offset })
                            })
                    }
                    "vault.put" => serde_json::from_value::<vault::VaultInput>(args)
                        .map_err(|_| "凭据输入不合法".to_string())
                        .and_then(|input| vault::agent_put(state, actor, input))
                        .map(|item| serde_json::json!({ "status": "stored", "item": item })),
                    "vault.organize" => serde_json::from_value::<vault::VaultOrganizeInput>(args)
                        .map_err(|_| "整理输入不合法".to_string())
                        .and_then(|input| vault::agent_organize(state, actor, input))
                        .map(|item| serde_json::json!({ "status": "organized", "item": item })),
                    "vault.delete" => match (args["id"].as_str(), args["expectedUpdatedAt"].as_str()) {
                        (Some(item_id), Some(expected)) => vault::agent_delete(state, actor, item_id, expected)
                            .map(|_| serde_json::json!({ "status": "deleted" })),
                        _ => Err("需要 id 和 expectedUpdatedAt".into()),
                    },
                    _ => Err("未知凭据工具".into()),
                };
                let is_error = result.is_err();
                let body = result.unwrap_or_else(|error| serde_json::json!({ "status": "rejected", "error": error }));
                return serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": serde_json::to_string(&body).unwrap_or_default() }], "isError": is_error } });
            }
            let conn = state.conn.lock().unwrap();
            let result = match name {
                "memory.search" => serde_json::to_value(MemoryService::search(
                    &conn,
                    config,
                    args["query"].as_str().unwrap_or(""),
                    actor,
                    args["limit"].as_i64().unwrap_or(8),
                    args["scopeKind"].as_str(),
                    args["scopeId"].as_str(),
                ))
                .unwrap_or_default(),
                "memory.remember" => MemoryService::remember(
                    &conn,
                    config,
                    args["body"].as_str().unwrap_or(""),
                    args["title"].as_str(),
                    &format!("mcp:{actor}"),
                    args["scopeKind"].as_str(),
                    args["scopeId"].as_str(),
                    actor,
                    false,
                    args["expectedRev"].as_i64(),
                ),
                "memory.forget" => serde_json::json!({ "ok": MemoryService::forget(&conn, args["id"].as_str().unwrap_or(""), actor) }),
                "memory.get" => serde_json::to_value(MemoryService::get(
                    &conn,
                    config,
                    actor,
                    args["id"].as_str(),
                    args["scopeKind"].as_str(),
                    args["scopeId"].as_str(),
                ))
                .unwrap_or_default(),
                "memory.export" => match crate::backup::export_share_backup(&conn) {
                    Ok(document) => {
                        let _ = store::audit(&conn, &format!("mcp:{actor}"), "memory.export", "share backup");
                        document
                    }
                    Err(error) => serde_json::json!({ "error": error }),
                },
                "memory.list" => {
                    let items: Vec<_> = MemoryService::list(
                        &conn,
                        args["limit"].as_i64().unwrap_or(20),
                        args["scopeKind"].as_str(),
                        args["scopeId"].as_str(),
                    ).into_iter().filter(|item| item.sensitivity == "public" || (item.sensitivity == "internal" && config.security.allow_internal_in_search)).collect();
                    serde_json::to_value(
                        items
                            .into_iter()
                            .map(|item| serde_json::json!({"id": item.id, "title": item.title, "scopeKind": item.scope_kind, "scopeId": item.scope_id, "updatedAt": item.updated_at}))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap_or_default()
                }
                _ => serde_json::json!({ "error": "unknown tool" }),
            };
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{ "type": "text", "text": serde_json::to_string_pretty(&result).unwrap_or_default() }] }
            })
        }
        _ => serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": method } }),
    }
}

pub fn spawn(state: AppState) -> Result<(), String> {
    let config = state.config.lock().unwrap().clone();
    crate::instance::reclaim_oneledger_port(&config.bind, config.port)?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    tauri::async_runtime::spawn(async move {
        let config = state.config.lock().unwrap().clone();
        let addr = format!("{}:{}", config.bind, config.port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => {
                let _ = tx.send(Ok(()));
                if let Err(err) = axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>()).await {
                    eprintln!("oneledger http stopped: {err}");
                }
            }
            Err(err) => {
                let _ = tx.send(Err(format!(
                    "端口 {addr} 已被占用，不会去挂旧进程。先关掉旧的 OneLedger 再开：{err}"
                )));
            }
        }
    });
    rx.recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| "HTTP 服务启动超时".to_string())?
}

