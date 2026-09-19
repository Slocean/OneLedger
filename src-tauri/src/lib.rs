use serde::Deserialize;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct ServerProcess(Mutex<Option<Child>>);

#[derive(Deserialize)]
struct LedgerConfig {
    #[serde(rename = "adminToken")]
    admin_token: Option<String>,
    port: Option<u16>,
}

fn home_dir() -> PathBuf {
    std::env::var("ONELEDGER_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".oneledger")
        })
}

fn read_config() -> LedgerConfig {
    let path = home_dir().join("config.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(LedgerConfig {
            admin_token: None,
            port: Some(7443),
        })
}

fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn wait_port(port: u16) -> bool {
    for _ in 0..40 {
        if port_open(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn start_server(resource_dir: PathBuf) -> Option<Child> {
    let port = read_config().port.unwrap_or(7443);
    if port_open(port) {
        return None;
    }
    let bundled = resource_dir.join("runtime").join("node.exe");
    let node = if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    };
    let entry = resource_dir.join("app-server").join("dist").join("index.js");
    let cwd = resource_dir.join("app-server");
    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg("serve")
        .current_dir(if cwd.exists() {
            cwd
        } else {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        })
        .env("ONELEDGER_HOME", home_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().ok()
}

#[tauri::command]
fn admin_token() -> String {
    read_config().admin_token.unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![admin_token])
        .setup(|app| {
            let resource_dir = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
            if let Some(process) = start_server(resource_dir) {
                *app.state::<ServerProcess>().0.lock().unwrap() = Some(process);
            }
            let port = read_config().port.unwrap_or(7443);
            wait_port(port);
            let token = read_config().admin_token.unwrap_or_default();
            let url = format!("http://127.0.0.1:{port}/");
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("OneLedger")
                .inner_size(1180.0, 820.0)
                .build()?;
            if !token.is_empty() {
                let script = format!(
                    r#"localStorage.setItem("oneledger.adminToken", {}); location.reload();"#,
                    serde_json::to_string(&token).unwrap()
                );
                let _ = window.eval(&script);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(mut child) = window.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OneLedger");
}
