mod collect;
mod config;
mod db;
mod distill;
mod http;
mod instance;
mod models;
mod scan;
mod service;
mod store;
mod sync;
mod update;
mod util;

use crate::config::{home_dir, load_config, save_config};
use crate::http::AppState;
use crate::service::MemoryService;
use crate::util::APP_VERSION;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn wait_for_our_http(url: &str) -> Result<(), String> {
    let health = format!("{url}api/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(400))
        .timeout_connect(Duration::from_millis(400))
        .try_proxy_from_env(false)
        .build();
    for _ in 0..80 {
        if let Ok(res) = agent.get(&health).call() {
            if let Ok(json) = res.into_json::<serde_json::Value>() {
                let version = json.get("version").and_then(|v| v.as_str()).unwrap_or("");
                if json.get("name").and_then(|v| v.as_str()) == Some("oneledger") && version == APP_VERSION {
                    return Ok(());
                }
                if !version.is_empty() && version != APP_VERSION {
                    return Err(format!(
                        "端口上跑的是旧进程 {version}，不是当前 {APP_VERSION}。先关掉旧的 OneLedger。"
                    ));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("HTTP 服务没有就绪".into())
}

fn admin_token_script(token: &str) -> String {
    format!(
        r#"(function () {{
  try {{
    var host = location.hostname;
    if (host !== "127.0.0.1" && host !== "localhost") return;
    localStorage.setItem("oneledger.adminToken", {token});
  }} catch (e) {{}}
}})();"#,
        token = serde_json::to_string(token).unwrap()
    )
}

#[tauri::command]
fn admin_token() -> String {
    load_config().admin_token
}

fn ensure_default_key(state: &AppState) {
    let conn = state.conn.lock().unwrap();
    let _ = MemoryService::retire_non_distilled(&conn);
    if store::list_keys(&conn).map(|keys| keys.is_empty()).unwrap_or(true) {
        let issued = MemoryService::issue_key(&conn, "default-agent");
        if let Some(token) = issued.get("token").and_then(|v| v.as_str()) {
            let _ = std::fs::write(home_dir().join("FIRST_MCP_KEY.txt"), format!("{token}\n"));
        }
    }
}

fn start_background(state: AppState) {
    let collect_min = state.config.lock().unwrap().collect.interval_min.max(5);
    let sync_min = state.config.lock().unwrap().sync.interval_min.max(5);
    let collect_state = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        crate::http::kick_collect_if_pending(&collect_state);
        let mut ticker = tokio::time::interval(Duration::from_secs(collect_min * 60));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            crate::http::start_collect(&collect_state);
        }
    });
    let sync_state = state;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(sync_min * 60));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let config = sync_state.config.lock().unwrap().clone();
            let conn = sync_state.conn.lock().unwrap();
            let _ = crate::sync::sync_with_remote(&conn, &config);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![admin_token])
        .setup(|app| {
            let mut config = load_config();
            save_config(&config);
            let conn = crate::db::open_db(&config.storage.sqlite_path).expect("open sqlite");
            let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            let web_dir = if resource_dir.join("web").join("index.html").exists() {
                resource_dir.join("web")
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist").join("web")
            };
            let state = AppState {
                config: Arc::new(Mutex::new(config.clone())),
                conn: Arc::new(Mutex::new(conn)),
                web_dir,
                collect: Arc::new(Mutex::new(crate::collect::CollectProgress::pending())),
            };
            {
                let cfg = state.config.lock().unwrap().clone();
                let db = state.conn.lock().unwrap();
                let _ = crate::collect::ensure_agents(&db, &cfg);
            }
            ensure_default_key(&state);
            crate::http::spawn(state.clone())?;
            config = load_config();
            let url = format!("http://127.0.0.1:{}/", config.port);
            wait_for_our_http(&url)?;
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("OneLedger")
                .inner_size(1180.0, 820.0);
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone())?;
            }
            if !config.admin_token.is_empty() {
                builder = builder.initialization_script(admin_token_script(&config.admin_token));
            }
            builder.build()?;
            start_background(state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OneLedger");
}
