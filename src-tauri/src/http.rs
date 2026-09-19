use crate::collect::{collect_agent, ensure_agents, path_exists, run_collectors};
use crate::config::{load_config, public_config, save_config, Config};
use crate::service::MemoryService;
use crate::store;
use crate::sync::{apply_remote_memories, authorize_node, sync_with_remote};
use crate::util::{hash_token, new_id, now_iso, safe_equal, APP_VERSION, DATA_SCHEMA_VERSION, PROTOCOL_VERSION};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use rusqlite::Connection;
use serde::Deserialize;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;

#[derive(RustEmbed)]
#[folder = "web-assets/"]
struct WebAssets;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Mutex<Config>>,
    pub conn: Arc<Mutex<Connection>>,
    pub web_dir: PathBuf,
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
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/status", get(status))
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/memories", get(memories))
        .route("/api/memories/export", get(export_memories))
        .route("/api/remember", post(remember))
        .route("/api/inbox/:id/reject", post(reject))
        .route("/api/version", get(version))
        .route("/api/updates", get(updates))
        .route("/api/updates/download", post(download_update))
        .route("/api/updates/apply", post(apply_update))
        .route("/api/inbox", get(inbox).post(create_inbox))
        .route("/api/audit", get(audit))
        .route("/api/agents", get(agents).post(create_agent))
        .route("/api/agents/:id", put(update_agent).delete(delete_agent))
        .route("/api/agents/:id/collect", post(collect_one))
        .route("/api/collect", post(collect_all))
        .route("/api/sync", post(sync_now))
        .route("/api/keys", get(keys).post(create_key))
        .route("/api/sync/pull", get(sync_pull))
        .route("/api/sync/push", post(sync_push))
        .route("/mcp", get(mcp_get).post(mcp_post))
        .layer(CorsLayer::permissive())
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
    let counts = store::counts(&state.conn.lock().unwrap()).unwrap_or(serde_json::json!({}));
    Json(serde_json::json!({
        "version": APP_VERSION,
        "role": config.sync.role,
        "storage": config.storage.driver,
        "bind": format!("{}:{}", config.bind, config.port),
        "counts": counts
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

async fn memories(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let list = MemoryService::list(&state.conn.lock().unwrap(), 100);
    Json(serde_json::json!({ "memories": list })).into_response()
}

async fn export_memories(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let memories = MemoryService::list(&state.conn.lock().unwrap(), 10_000);
    Json(serde_json::json!({
        "name": "oneledger",
        "version": APP_VERSION,
        "exportedAt": crate::util::now_iso(),
        "count": memories.len(),
        "memories": memories
    }))
    .into_response()
}

#[derive(Deserialize)]
struct RememberBody {
    body: Option<String>,
    title: Option<String>,
    promote: Option<bool>,
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
        None,
        None,
        "admin",
        body.promote.unwrap_or(false),
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
    Json(crate::update::check(&config.update_url)).into_response()
}

async fn download_update(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    Json(crate::update::download(&config.update_url)).into_response()
}

async fn apply_update(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    Json(crate::update::apply()).into_response()
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
    );
    Json(result).into_response()
}

async fn inbox(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let config = state.config.lock().unwrap().clone();
    if !admin_ok(&headers, &config) {
        return unauthorized();
    }
    let items = store::list_inbox(&state.conn.lock().unwrap()).unwrap_or_default();
    Json(serde_json::json!({ "inbox": items })).into_response()
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
    let results = run_collectors(&state.conn.lock().unwrap(), &MemoryService, &config);
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
                "lastUsedAt": key.last_used_at
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
    Json(MemoryService::issue_key(&state.conn.lock().unwrap(), body.name.as_deref().unwrap_or("agent"))).into_response()
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

async fn mcp_post(State(state): State<AppState>, headers: HeaderMap, Json(payload): Json<serde_json::Value>) -> Response {
    let config = state.config.lock().unwrap().clone();
    let Some(token) = bearer(&headers) else {
        return unauthorized();
    };
    let conn = state.conn.lock().unwrap();
    let Some(key) = store::find_key_by_hash(&conn, &hash_token(&token)).ok().flatten() else {
        return unauthorized();
    };
    let _ = store::touch_key(&conn, &key.id);
    let name = key.name.clone();
    let tools = key.tools.clone();
    drop(conn);
    Json(handle_mcp(&state, &config, &name, &tools, payload)).into_response()
}

fn handle_mcp(state: &AppState, config: &Config, actor: &str, tools: &str, payload: serde_json::Value) -> serde_json::Value {
    let id = payload.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let method = payload.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let permitted: Vec<&str> = tools.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    match method {
        "initialize" => serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "oneledger", "version": APP_VERSION }
            }
        }),
        "notifications/initialized" | "ping" => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => {
            let all = [
                ("memory.search", "Search durable shared memories. Results never include secret-classified text.", serde_json::json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"number"}},"required":["query"]})),
                ("memory.remember", "Replace the distilled write-up for this scope. Send the full refined text after you distilled the source material, not one fact per call. Same scope overwrites the previous document. OneLedger does not summarize. Secrets are redacted and never recalled.", serde_json::json!({"type":"object","properties":{"body":{"type":"string"},"title":{"type":"string"},"scopeKind":{"type":"string"},"scopeId":{"type":"string"}},"required":["body"]})),
                ("memory.forget", "Remove an official distilled memory so it is no longer recalled.", serde_json::json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]})),
                ("memory.list", "List memory titles only, without bodies.", serde_json::json!({"type":"object","properties":{"limit":{"type":"number"}}})),
            ];
            let tools: Vec<serde_json::Value> = all
                .into_iter()
                .filter(|(name, _, _)| permitted.contains(name))
                .map(|(name, desc, schema)| serde_json::json!({"name": name, "description": desc, "inputSchema": schema}))
                .collect();
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })
        }
        "tools/call" => {
            let name = payload["params"]["name"].as_str().unwrap_or("");
            if !permitted.contains(&name) {
                return serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "tool not allowed" } });
            }
            let args = payload["params"]["arguments"].clone();
            let conn = state.conn.lock().unwrap();
            let result = match name {
                "memory.search" => serde_json::to_value(MemoryService::search(
                    &conn,
                    config,
                    args["query"].as_str().unwrap_or(""),
                    actor,
                    args["limit"].as_i64().unwrap_or(8),
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
                ),
                "memory.forget" => serde_json::json!({ "ok": MemoryService::forget(&conn, args["id"].as_str().unwrap_or(""), actor) }),
                "memory.list" => {
                    let items = MemoryService::list(&conn, args["limit"].as_i64().unwrap_or(20));
                    serde_json::to_value(
                        items
                            .into_iter()
                            .map(|item| serde_json::json!({"id": item.id, "title": item.title, "scopeKind": item.scope_kind, "updatedAt": item.updated_at}))
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

pub async fn serve(state: AppState) -> anyhow_like::Result<()> {
    let config = state.config.lock().unwrap().clone();
    let addr: SocketAddr = format!("{}:{}", config.bind, config.port).parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router(state)).await?;
    Ok(())
}

mod anyhow_like {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}
