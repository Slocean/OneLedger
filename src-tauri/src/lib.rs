mod collect;
mod config;
mod db;
mod distill;
mod http;
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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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
    {
        let conn = state.conn.lock().unwrap();
        let config = state.config.lock().unwrap().clone();
        let _ = crate::collect::run_collectors(&conn, &MemoryService, &config);
    }
    let collect_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(collect_min * 60));
        loop {
            ticker.tick().await;
            let conn = collect_state.conn.lock().unwrap();
            let config = collect_state.config.lock().unwrap().clone();
            let _ = crate::collect::run_collectors(&conn, &MemoryService, &config);
        }
    });
    let sync_state = state;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(sync_min * 60));
        loop {
            ticker.tick().await;
            let conn = sync_state.conn.lock().unwrap();
            let config = sync_state.config.lock().unwrap().clone();
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
            };
            ensure_default_key(&state);
            let serve_state = state.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::http::serve(serve_state).await;
            });
            start_background(state);
            let port = config.port;
            for _ in 0..40 {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            config = load_config();
            let url = format!("http://127.0.0.1:{}/", config.port);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("OneLedger")
                .inner_size(1180.0, 820.0)
                .build()?;
            if !config.admin_token.is_empty() {
                let script = format!(
                    r#"localStorage.setItem("oneledger.adminToken", {}); location.reload();"#,
                    serde_json::to_string(&config.admin_token).unwrap()
                );
                let _ = window.eval(&script);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OneLedger");
}
