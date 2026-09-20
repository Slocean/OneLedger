use rand::RngCore;
use sha2::{Digest, Sha256};

pub const APP_VERSION: &str = "0.3.0";
pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const DATA_SCHEMA_VERSION: i64 = 3;
pub const PROTOCOL_VERSION: i32 = 1;

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

pub fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub fn hash_token(token: &str) -> String {
    sha256_hex(&format!("oneledger.token.v1:{token}"))
}

pub fn safe_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn clip_title(text: &str, fallback: &str) -> String {
    let line = text.lines().map(str::trim).find(|item| !item.is_empty()).unwrap_or(fallback);
    if line.chars().count() > 80 {
        format!("{}...", line.chars().take(77).collect::<String>())
    } else {
        line.to_string()
    }
}

pub fn random_secret(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    data_encoding_base64url(&buf)
}

fn data_encoding_base64url(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < input.len() {
            out.push(T[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < input.len() {
            out.push(T[(b2 & 63) as usize] as char);
        }
        i += 3;
    }
    out
}
