use crate::models::MemoryRecord;
use std::collections::HashSet;

pub fn token_set(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(str::to_string)
        .collect()
}

pub fn find_conflicts(body: &str, title: &str, actives: &[MemoryRecord]) -> Vec<MemoryRecord> {
    let incoming = token_set(&format!("{title}\n{body}"));
    actives
        .iter()
        .filter(|item| overlap(&incoming, &token_set(&format!("{}\n{}", item.title, item.body))) >= 0.45)
        .cloned()
        .collect()
}

fn overlap(left: &HashSet<String>, right: &HashSet<String>) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.iter().filter(|token| right.contains(*token)).count() as f32;
    shared / (left.len().min(right.len()) as f32)
}

pub fn should_auto_promote(source: &str, _sensitivity: &str, _conflicts: usize, promote: bool) -> bool {
    if promote {
        return true;
    }
    source.starts_with("mcp:") || source == "ui" || source.starts_with("ui:")
}
