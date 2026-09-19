use crate::config::Config;
use crate::models::MemoryRecord;
use crate::store;
use crate::util::{now_iso, PROTOCOL_VERSION};
use rusqlite::Connection;

pub fn apply_remote_memories(conn: &Connection, memories: Vec<MemoryRecord>) -> i64 {
    let mut applied = 0;
    for memory in memories {
        if memory.sensitivity == "secret" {
            continue;
        }
        if let Ok(Some(current)) = store::get_memory(conn, &memory.id) {
            if current.rev >= memory.rev {
                continue;
            }
        }
        if store::upsert_memory(conn, &memory).is_ok() {
            applied += 1;
        }
    }
    applied
}

pub fn sync_with_remote(conn: &Connection, config: &Config) -> serde_json::Value {
    if config.sync.role != "leaf" || config.sync.remote_url.trim().is_empty() {
        return serde_json::json!({ "pulled": 0, "pushed": 0, "skipped": true });
    }
    let base = config.sync.remote_url.trim_end_matches('/');
    let since = store::get_sync_cursor(conn).unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into());
    let pull_url = format!("{base}/api/sync/pull?since={}", urlencoding(&since));
    let pull = ureq::get(&pull_url)
        .set("authorization", &format!("Bearer {}", config.sync.node_key))
        .set("x-oneledger-protocol", &PROTOCOL_VERSION.to_string())
        .call();
    let Ok(response) = pull else {
        return serde_json::json!({ "pulled": 0, "pushed": 0, "skipped": false, "error": "pull failed" });
    };
    if response.status() >= 300 {
        return serde_json::json!({ "pulled": 0, "pushed": 0, "skipped": false, "error": format!("pull {}", response.status()) });
    }
    let pulled: serde_json::Value = response.into_json().unwrap_or_else(|_| serde_json::json!({}));
    let memories: Vec<MemoryRecord> = serde_json::from_value(pulled["memories"].clone()).unwrap_or_default();
    let applied = apply_remote_memories(conn, memories);
    let outgoing: Vec<MemoryRecord> = store::changed_since(conn, &since)
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.sensitivity != "secret")
        .collect();
    let push = ureq::post(&format!("{base}/api/sync/push"))
        .set("content-type", "application/json")
        .set("authorization", &format!("Bearer {}", config.sync.node_key))
        .set("x-oneledger-protocol", &PROTOCOL_VERSION.to_string())
        .send_json(serde_json::json!({ "memories": outgoing }));
    match push {
        Ok(res) if res.status() < 300 => {
            let _ = store::set_sync_cursor(conn, &now_iso());
            serde_json::json!({ "pulled": applied, "pushed": outgoing.len(), "skipped": false })
        }
        Ok(res) => serde_json::json!({ "pulled": applied, "pushed": 0, "skipped": false, "error": format!("push {}", res.status()) }),
        Err(_) => serde_json::json!({ "pulled": applied, "pushed": 0, "skipped": false, "error": "push failed" }),
    }
}

pub fn authorize_node(config: &Config, header: Option<&str>) -> bool {
    header.and_then(|value| value.strip_prefix("Bearer ")).is_some_and(|token| token == config.sync.node_key)
}

fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for ch in value.bytes() {
        match ch {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(ch as char),
            _ => out.push_str(&format!("%{ch:02X}")),
        }
    }
    out
}
