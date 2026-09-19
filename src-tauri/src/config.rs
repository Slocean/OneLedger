use crate::util::{random_secret, CONFIG_SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub schema_version: u32,
    pub bind: String,
    pub port: u16,
    pub storage: StorageConfig,
    pub sync: SyncConfig,
    pub collect: CollectConfig,
    pub distill: DistillConfig,
    pub security: SecurityConfig,
    pub update_url: String,
    pub admin_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageConfig {
    pub driver: String,
    pub sqlite_path: String,
    pub postgres_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub role: String,
    pub remote_url: String,
    pub node_key: String,
    pub interval_min: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectConfig {
    pub cursor: bool,
    pub claude: bool,
    pub codex: bool,
    #[serde(rename = "continue")]
    pub continue_tool: bool,
    pub projects: bool,
    pub interval_min: u64,
    pub extra_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityConfig {
    pub scan_enabled: bool,
    pub allow_internal_in_search: bool,
}

pub fn home_dir() -> PathBuf {
    std::env::var("ONELEDGER_HOME")
        .ok()
        .filter(|item| !item.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(".oneledger")
        })
}

pub fn config_path() -> PathBuf {
    home_dir().join("config.json")
}

pub fn default_sqlite_path() -> String {
    home_dir()
        .join("data")
        .join("oneledger.db")
        .to_string_lossy()
        .into_owned()
}

pub fn default_config() -> Config {
    Config {
        schema_version: CONFIG_SCHEMA_VERSION,
        bind: "127.0.0.1".into(),
        port: 7443,
        storage: StorageConfig {
            driver: "sqlite".into(),
            sqlite_path: default_sqlite_path(),
            postgres_url: String::new(),
        },
        sync: SyncConfig {
            role: "local".into(),
            remote_url: String::new(),
            node_key: random_secret(18),
            interval_min: 15,
        },
        collect: CollectConfig {
            cursor: true,
            claude: true,
            codex: true,
            continue_tool: true,
            projects: true,
            interval_min: 30,
            extra_roots: vec![],
        },
        distill: DistillConfig {
            provider: "none".into(),
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
        },
        security: SecurityConfig {
            scan_enabled: true,
            allow_internal_in_search: true,
        },
        update_url: String::new(),
        admin_token: random_secret(24),
    }
}

pub fn load_config() -> Config {
    let path = config_path();
    if !path.exists() {
        let created = default_config();
        save_config(&created);
        return created;
    }
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    let mut cfg = default_config();
    if let Ok(partial) = serde_json::from_value::<Config>(parsed.clone()) {
        cfg = partial;
        cfg.schema_version = CONFIG_SCHEMA_VERSION;
    } else if let Ok(merged) = serde_json::from_value::<serde_json::Value>(parsed) {
        if let Ok(next) = serde_json::from_value::<Config>(deep_merge(
            serde_json::to_value(cfg.clone()).unwrap(),
            merged,
        )) {
            cfg = next;
            cfg.schema_version = CONFIG_SCHEMA_VERSION;
        }
    }
    if cfg.admin_token.is_empty() {
        cfg.admin_token = random_secret(24);
    }
    save_config(&cfg);
    cfg
}

fn deep_merge(mut base: serde_json::Value, overlay: serde_json::Value) -> serde_json::Value {
    match (&mut base, overlay) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                let next = deep_merge(base_map.remove(&key).unwrap_or(serde_json::Value::Null), value);
                base_map.insert(key, next);
            }
            serde_json::Value::Object(base_map.clone())
        }
        (_, value) if !value.is_null() => value,
        (keep, _) => keep.clone(),
    }
}

pub fn save_config(config: &Config) {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::create_dir_all(home_dir());
    let _ = fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default() + "\n");
}

pub fn public_config(config: &Config) -> serde_json::Value {
    let mut value = serde_json::to_value(config).unwrap_or_default();
    value["adminToken"] = serde_json::json!(if config.admin_token.is_empty() { "" } else { "•••• set" });
    value["sync"]["nodeKey"] = serde_json::json!(if config.sync.node_key.is_empty() { "" } else { "•••• set" });
    value["distill"]["apiKey"] = serde_json::json!(if config.distill.api_key.is_empty() { "" } else { "•••• set" });
    if !config.storage.postgres_url.is_empty() {
        value["storage"]["postgresUrl"] = serde_json::json!("(set)");
    }
    value
}

pub fn claude_home() -> PathBuf {
    env_or_home("CLAUDE_HOME", ".claude")
}

pub fn cursor_agent_stores_dir() -> PathBuf {
    if let Ok(path) = std::env::var("CURSOR_AGENT_STORES") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    if cfg!(windows) {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            home_user().join("AppData").join("Local").to_string_lossy().into_owned()
        });
        PathBuf::from(local)
            .join("Cursor")
            .join("AgentStores")
            .join("cursor_agent_stores")
    } else if cfg!(target_os = "macos") {
        home_user()
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("AgentStores")
            .join("cursor_agent_stores")
    } else {
        home_user()
            .join(".config")
            .join("Cursor")
            .join("AgentStores")
            .join("cursor_agent_stores")
    }
}

pub fn tool_home(name: &str, env_name: &str) -> PathBuf {
    env_or_home(env_name, name)
}

fn env_or_home(env_name: &str, name: &str) -> PathBuf {
    std::env::var(env_name)
        .ok()
        .filter(|item| !item.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_user().join(name))
}

fn home_user() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
