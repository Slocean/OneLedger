use regex::Regex;
use std::sync::OnceLock;

pub struct ScanResult {
    pub clean_text: String,
    pub hits: Vec<(String, String)>,
    pub highest: String,
    pub locations: Vec<serde_json::Value>,
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
    static UUID: OnceLock<Regex> = OnceLock::new();
    if UUID.get_or_init(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").expect("uuid regex"))
        .is_match(token) {
        return false;
    }
    if !token.chars().any(|ch| ch.is_ascii_alphabetic()) || !token.chars().any(|ch| ch.is_ascii_digit()) {
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
            ("private_key", "secret", r"(?s)-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----.*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"),
            ("private_key_incomplete", "secret", r"(?s)-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----.*"),
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
    let mut locations = Vec::new();
    for (kind, level, re) in rules {
        if re.is_match(&clean) {
            hits.push((kind.to_string(), level.to_string()));
            for found in re.find_iter(&clean) {
                let offset = input.find(found.as_str()).unwrap_or(found.start()).min(input.len());
                let before = &input[..offset];
                locations.push(serde_json::json!({"type": kind, "line": before.bytes().filter(|b| *b == b'\n').count() + 1}));
            }
            clean = re.replace_all(&clean, format!("[REDACTED:{kind}]")).into_owned();
        }
    }
    static ENTROPY: OnceLock<Regex> = OnceLock::new();
    let entropy = ENTROPY.get_or_init(|| Regex::new(r"\b[A-Za-z0-9+=_-]{32,128}\b").expect("entropy regex"));
    let source = clean.clone();
    clean = entropy
        .replace_all(&source, |caps: &regex::Captures| {
            let token = &caps[0];
            if looks_high_entropy(token) {
                hits.push(("high_entropy".into(), "secret".into()));
                let offset = input.find(token).unwrap_or_else(|| caps.get(0).map(|item| item.start()).unwrap_or(0)).min(input.len());
                let line = input[..offset].bytes().filter(|b| *b == b'\n').count() + 1;
                locations.push(serde_json::json!({"type": "high_entropy", "line": line}));
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
        locations,
    }
}

/// 二次验证：对已完成替换的文本再次扫描。
/// 返回仍命中的规则与位置；为空表示可以安全写入。
/// 命中非空说明替换不完整（或无法证明完整），调用方必须拒收。
pub fn verify_redacted(text: &str) -> Vec<serde_json::Value> {
    if text.trim().is_empty() {
        return vec![];
    }
    let result = scan_and_redact(text);
    if result.hits.is_empty() {
        return vec![];
    }
    if result.locations.is_empty() {
        return result
            .hits
            .into_iter()
            .map(|(kind, _)| serde_json::json!({"type": kind, "line": serde_json::Value::Null}))
            .collect();
    }
    result.locations
}

#[cfg(test)]
mod tests {
    use super::{scan_and_redact, verify_redacted};

    #[test]
    fn preserves_paths_and_uuids() {
        let input = "equipment/v2/production/storeList f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
        let result = scan_and_redact(input);
        assert_eq!(result.clean_text, input);
        assert!(result.hits.is_empty());
    }

    #[test]
    fn removes_a_complete_private_key_block() {
        let input = "note\n-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\nkeep this";
        let result = scan_and_redact(input);
        assert!(!result.clean_text.contains("secret-material"));
        assert!(result.clean_text.contains("keep this"));
        assert_eq!(result.hits[0].0, "private_key");
    }

    #[test]
    fn removes_the_remainder_of_an_incomplete_private_key() {
        let result = scan_and_redact("keep\n-----BEGIN PRIVATE KEY-----\nraw-secret-lines");
        assert!(result.clean_text.contains("keep"));
        assert!(!result.clean_text.contains("raw-secret-lines"));
        assert_eq!(result.hits[0].0, "private_key_incomplete");
    }

    /// 两端共享的回归样本：同一份样本必须给出一致状态。
    /// 样本不含真实凭据。
    const SAMPLES: &[(&str, bool)] = &[
        ("配置里写了 token sk-abcdefghijklmnopqrstuvwxyz123456 也要保留说明。", true),
        ("说明\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\n结尾", true),
        ("残留\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0", true),
        ("TOKEN=0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c", true),
        ("SECRET = 0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c", true),
        ("ghp_abcdefghijklmnopqrstuvwxyz0123456789", true),
        ("postgres://admin:s3cr3tpass@db.internal:5432/app", true),
        ("配置如下\nOPENAI_API_KEY = sk-abcdefghijklmnopqrstuvwxyz123456\nDATABASE_URL=postgres://u:p4ssw0rd@host:5432/db\n结束", true),
        ("equipment/v2/production/storeList f81d4fae-7dec-11d0-a765-00a0c91e6bf6", false),
        ("项目路径 D:\\PROJECT\\CofoeAirLink_Web\\src\\equipment\\v2\\storeList.ts", false),
        ("内容指纹 a6778de21a25c0888b933c8ffb230062d28b6448e40c1747629c290fa171bbf6", false),
        ("采集器只读取约定文件，蒸馏后形成连贯的项目记忆。", false),
    ];

    #[test]
    fn credential_samples_are_redacted_and_leave_no_residue() {
        for (sample, expects_secret) in SAMPLES {
            let result = scan_and_redact(sample);
            assert_eq!(
                result.highest == "secret",
                *expects_secret,
                "sample 的敏感级别不符合预期：{sample}"
            );
            assert!(
                verify_redacted(&result.clean_text).is_empty(),
                "替换后仍有残留：{sample}"
            );
        }
    }

    #[test]
    fn residue_detection_reports_hits() {
        // 故意保留一段未替换的私钥残留，验证二次验证能发现
        let residue = "说明\n-----BEGIN PRIVATE KEY-----\n仍然存在的密钥材料";
        let hits = verify_redacted(residue);
        assert!(!hits.is_empty());
        assert!(hits.iter().any(|hit| hit["type"] == "private_key_incomplete"));

        // 已替换的标记本身不得自我触发
        for marker in [
            "[REDACTED:private_key]",
            "[REDACTED:high_entropy]",
            "[REDACTED:env_secret]",
            "[REDACTED:openai_key]",
            "[REDACTED:private_key_incomplete]",
        ] {
            assert!(verify_redacted(marker).is_empty(), "标记被误判：{marker}");
        }
    }
}
