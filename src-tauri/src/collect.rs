use crate::config::{claude_home, cursor_agent_stores_dir, tool_home, Config};
use crate::models::{AgentRecord, CollectResult};
use crate::service::MemoryService;
use crate::store;
use crate::util::now_iso;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

pub fn ensure_agents(conn: &Connection, config: &Config) -> rusqlite::Result<()> {
    let existing: Vec<String> = store::list_agents(conn)?.into_iter().map(|item| item.id).collect();
    for blueprint in builtin_blueprints(config) {
        if existing.iter().any(|id| id == &blueprint.id) {
            continue;
        }
        store::upsert_agent(conn, &blueprint)?;
    }
    Ok(())
}

pub fn builtin_blueprints(config: &Config) -> Vec<AgentRecord> {
    let extra = config
        .collect
        .extra_roots
        .iter()
        .find(|item| !item.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into()));
    vec![
        agent("cursor", "Cursor", "cursor", cursor_agent_stores_dir(), config.collect.cursor),
        agent("claude", "Claude Code", "claude", claude_home().join("projects"), config.collect.claude),
        agent("codex", "Codex", "codex", tool_home(".codex", "CODEX_HOME"), config.collect.codex),
        agent("continue", "Continue", "continue", tool_home(".continue", "CONTINUE_HOME"), config.collect.continue_tool),
        agent("zcode", "ZCode", "zcode", tool_home(".zcode", "ZCODE_HOME"), config.collect.zcode),
        agent("workbuddy", "WorkBuddy", "workbuddy", tool_home(".workbuddy", "WORKBUDDY_HOME"), config.collect.workbuddy),
        agent("qoder", "Qoder", "qoder", tool_home(".qoder", "QODER_HOME"), config.collect.qoder),
        agent("projects", "项目约定文件", "project", PathBuf::from(extra), config.collect.projects),
    ]
}

fn agent(id: &str, name: &str, kind: &str, root: PathBuf, enabled: bool) -> AgentRecord {
    AgentRecord {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        builtin: true,
        enabled,
        root_path: root.to_string_lossy().into_owned(),
        last_scanned_at: None,
        last_scanned_files: 0,
        last_ingested: 0,
        last_queued: 0,
        last_redacted: 0,
        last_error: String::new(),
        created_at: now_iso(),
    }
}

pub fn path_exists(root: &str) -> bool {
    !root.trim().is_empty() && Path::new(root).exists()
}

pub fn collect_agent(conn: &Connection, _service: &MemoryService, mut agent: AgentRecord) -> CollectResult {
    let files = if agent.kind == "project" {
        read_project_memories(&agent.root_path)
    } else if path_exists(&agent.root_path) {
        read_collected(&agent.root_path)
    } else {
        vec![]
    };
    let result = MemoryService::ingest_collected(conn, &agent.id, &files);
    agent.last_scanned_at = Some(now_iso());
    agent.last_scanned_files = result.scanned_files;
    agent.last_ingested = result.ingested;
    agent.last_queued = result.queued;
    agent.last_redacted = result.redacted;
    agent.last_error = if path_exists(&agent.root_path) {
        String::new()
    } else {
        "路径不存在".into()
    };
    let _ = store::upsert_agent(conn, &agent);
    result
}

pub fn run_collectors(conn: &Connection, service: &MemoryService, config: &Config) -> Vec<CollectResult> {
    let _ = ensure_agents(conn, config);
    store::list_agents(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|agent| agent.enabled)
        .map(|agent| collect_agent(conn, service, agent))
        .collect()
}

fn read_collected(root: &str) -> Vec<(String, String, String)> {
    walk_text(Path::new(root), 400, false)
        .into_iter()
        .filter_map(|file| read_one(root, &file))
        .collect()
}

fn read_project_memories(root: &str) -> Vec<(String, String, String)> {
    walk_text(Path::new(root), 200, true)
        .into_iter()
        .filter_map(|file| read_one(root, &file))
        .collect()
}

fn read_one(root: &str, file: &Path) -> Option<(String, String, String)> {
    let text = fs::read_to_string(file).ok()?;
    let rel = file.strip_prefix(root).unwrap_or(file).to_string_lossy().into_owned();
    Some((file.to_string_lossy().into_owned(), text, rel))
}

fn is_project_memory_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    const EXACT: &[&str] = &[
        "agents.md",
        "claude.md",
        "claude.local.md",
        ".cursorrules",
        ".windsurfrules",
        ".clinerules",
        "gemini.md",
    ];
    if EXACT.contains(&name.as_str()) {
        return true;
    }
    let parent = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
    let grand = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("");
    (name.ends_with(".md") || name.ends_with(".mdc")) && parent.eq_ignore_ascii_case("rules") && grand.eq_ignore_ascii_case(".cursor")
}

fn walk_text(root: &Path, max_files: usize, project_only: bool) -> Vec<PathBuf> {
    if !root.exists() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        if out.len() >= max_files {
            break;
        }
        let Ok(entries) = fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if matches!(name.as_str(), "node_modules" | ".git" | ".sync" | "dist" | "build" | ".next" | "coverage" | "extensions") {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if project_only {
                if !is_project_memory_file(&path) {
                    continue;
                }
            } else {
                let lower = name.to_lowercase();
                if ![".md", ".txt", ".json", ".yml", ".yaml", ".mdc"].iter().any(|ext| lower.ends_with(ext)) {
                    continue;
                }
            }
            if fs::metadata(&path).map(|m| m.len() > 256_000).unwrap_or(true) {
                continue;
            }
            out.push(path);
        }
    }
    out
}
