use regex::Regex;
use std::sync::OnceLock;

pub struct ScanResult {
    pub clean_text: String,
    pub hits: Vec<(String, String)>,
    pub highest: String,
}

fn rank(level: &str) -> i32 {
    match level {
        "secret" => 3,
        "pii" => 2,
        "internal" => 1,
        _ => 0,
    }
}

fn higher(a: &str, b: &str) -> String {
    if rank(a) >= rank(b) {
        a.to_string()
    } else {
        b.to_string()
    }
}

fn looks_high_entropy(token: &str) -> bool {
    let len = token.len();
    if !(32..=128).contains(&len) {
        return false;
    }
    if !token.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=' | '_' | '-')) {
        return false;
    }
    let unique = token.chars().collect::<std::collections::HashSet<_>>().len();
    unique as f32 >= 20.0_f32.min(len as f32 * 0.4)
}

pub fn scan_and_redact(input: &str) -> ScanResult {
    static RULES: OnceLock<Vec<(&'static str, &'static str, Regex)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            ("aws_access_key", "secret", r"\bAKIA[0-9A-Z]{16}\b"),
            ("github_token", "secret", r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
            ("openai_key", "secret", r"\bsk-[A-Za-z0-9_-]{20,}\b"),
            ("jwt", "secret", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
            ("private_key", "secret", r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"),
            ("connection_string", "secret", r"(?i)\b(?:postgres|mysql|mongodb|redis)://[^\s]+:[^\s]+@[^\s]+"),
            ("env_secret", "secret", r"(?i)\b(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\s*[=:]\s*\S+"),
            ("email", "pii", r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"),
        ]
        .into_iter()
        .map(|(kind, level, pat)| (kind, level, Regex::new(pat).expect("scan regex")))
        .collect()
    });

    let mut clean = input.to_string();
    let mut hits = Vec::new();
    for (kind, level, re) in rules {
        if re.is_match(input) {
            hits.push((kind.to_string(), level.to_string()));
            clean = re.replace_all(&clean, format!("[REDACTED:{kind}]")).into_owned();
        }
    }
    let entropy = Regex::new(r"\b[A-Za-z0-9+/=_-]{32,128}\b").expect("entropy regex");
    clean = entropy
        .replace_all(&clean, |caps: &regex::Captures| {
            let token = &caps[0];
            if looks_high_entropy(token) {
                hits.push(("high_entropy".into(), "secret".into()));
                "[REDACTED:high_entropy]".into()
            } else {
                token.to_string()
            }
        })
        .into_owned();
    let highest = hits.iter().fold("public".to_string(), |acc, item| higher(&acc, &item.1));
    ScanResult {
        clean_text: clean,
        hits,
        highest,
    }
}
