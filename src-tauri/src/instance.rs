use crate::util::silent_command;
use serde_json::Value;
#[cfg(test)]
use std::process::Command;
use std::time::{Duration, Instant};

pub fn reclaim_oneledger_port(bind: &str, port: u16) -> Result<(), String> {
    let addr = format!("{bind}:{port}");
    if port_free(&addr) {
        return Ok(());
    }
    let health = probe_health(bind, port);
    let is_oneledger = health.as_ref().is_some_and(is_oneledger_health);
    let version = health
        .as_ref()
        .and_then(|item| item.get("version"))
        .and_then(|item| item.as_str())
        .unwrap_or("?");
    let pids: Vec<u32> = listening_pids(port)
        .into_iter()
        .filter(|&pid| pid != std::process::id() && pid > 4)
        .filter(|&pid| is_oneledger || process_looks_like_oneledger(pid))
        .collect();
    if pids.is_empty() {
        return Err(if is_oneledger {
            format!("端口 {addr} 被旧 OneLedger {version} 占用，但找不到进程")
        } else {
            format!("端口 {addr} 被其他程序占用，未关闭")
        });
    }
    for pid in &pids {
        eprintln!("oneledger: closing stale process {pid} ({version}) on {addr}");
        kill_process(*pid);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if port_free(&addr) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    Err(format!("已结束旧进程 {:?}，但端口 {addr} 仍被占用", pids))
}

fn port_free(addr: &str) -> bool {
    std::net::TcpListener::bind(addr).is_ok()
}

fn probe_health(bind: &str, port: u16) -> Option<Value> {
    let host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1"
    } else {
        bind
    };
    let url = format!("http://{host}:{port}/api/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(400))
        .timeout_connect(Duration::from_millis(400))
        .try_proxy_from_env(false)
        .build();
    agent.get(&url).call().ok()?.into_json().ok()
}

fn is_oneledger_health(value: &Value) -> bool {
    value.get("name").and_then(|item| item.as_str()) == Some("oneledger")
}

pub fn parse_listening_pids(output: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let upper = line.to_ascii_uppercase();
        if !upper.starts_with("TCP") {
            continue;
        }
        if !upper.contains("LISTENING") && !line.contains("侦听") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        if !local_has_port(parts[1], port) {
            continue;
        }
        let Ok(pid) = parts[parts.len() - 1].parse::<u32>() else {
            continue;
        };
        if pid > 4 && !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

fn local_has_port(local: &str, port: u16) -> bool {
    let suffix = format!(":{port}");
    let bracket = format!("]:{port}");
    local.ends_with(&suffix) || local.ends_with(&bracket)
}

fn listening_pids(port: u16) -> Vec<u32> {
    let output = silent_command("netstat")
        .args(["-ano", "-p", "tcp"])
        .output()
        .ok()
        .map(|item| String::from_utf8_lossy(&item.stdout).into_owned())
        .unwrap_or_default();
    parse_listening_pids(&output, port)
}

fn process_looks_like_oneledger(pid: u32) -> bool {
    process_blob(pid).to_ascii_lowercase().contains("oneledger")
}

fn process_blob(pid: u32) -> String {
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "$p=Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\"; if($p){{ $p.Name + ' ' + $p.CommandLine }}"
            ),
        ])
        .output()
        .ok();
    output
        .map(|item| String::from_utf8_lossy(&item.stdout).trim().to_string())
        .unwrap_or_default()
}

fn kill_process(pid: u32) {
    let _ = silent_command("taskkill")
        .args(["/PID", &pid.to_string(), "/F", "/T"])
        .output();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_listening_pid() {
        let sample = "\
  TCP    127.0.0.1:7443         0.0.0.0:0              LISTENING       7040\r\n\
  TCP    127.0.0.1:7443         127.0.0.1:1234         TIME_WAIT       0\r\n\
  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4\r\n\
  TCP    [::1]:7443             [::]:0                 LISTENING       7040\r\n";
        assert_eq!(parse_listening_pids(sample, 7443), vec![7040]);
    }

    #[test]
    fn health_name_is_the_signal() {
        assert!(is_oneledger_health(&serde_json::json!({"name":"oneledger","version":"0.3.0"})));
        assert!(!is_oneledger_health(&serde_json::json!({"name":"nginx"})));
    }

    #[test]
    fn reclaim_closes_stale_oneledger() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let mut child = Command::new("node")
            .args([
                "-e",
                &format!(
                    "require('http').createServer((q,s)=>{{s.setHeader('content-type','application/json');s.end(JSON.stringify({{ok:true,name:'oneledger',version:'0.3.0'}}));}}).listen({port},'127.0.0.1');"
                ),
            ])
            .spawn()
            .expect("node");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && probe_health("127.0.0.1", port).is_none() {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(probe_health("127.0.0.1", port).is_some(), "dummy health server did not start");
        reclaim_oneledger_port("127.0.0.1", port).expect("reclaim");
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(child.try_wait().ok().flatten().is_some(), "stale process should be gone");
        assert!(port_free(&format!("127.0.0.1:{port}")));
    }
}
