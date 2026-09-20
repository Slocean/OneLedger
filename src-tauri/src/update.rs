use crate::util::APP_VERSION;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const OWNER: &str = "Slocean";
const REPO: &str = "OneLedger";
const DEFAULT_CHANNEL: &str = "https://raw.githubusercontent.com/Slocean/OneLedger/main/app_update.json";
const CHANNEL_MIRRORS: &[&str] = &[
    DEFAULT_CHANNEL,
    "https://github.com/Slocean/OneLedger/raw/main/app_update.json",
    "https://cdn.jsdelivr.net/gh/Slocean/OneLedger@main/app_update.json",
    "https://raw.gitmirror.com/Slocean/OneLedger/main/app_update.json",
];
const EMBEDDED_CHANNEL: &str = include_str!("../../app_update.json");
const RELEASES_PAGE: &str = "https://github.com/Slocean/OneLedger/releases";
const PORTABLE_ASSET: &str = "OneLedger-Portable.exe";
const SETUP_ASSET: &str = "OneLedger-Setup.exe";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const CHANNEL_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flavor {
    Portable,
    Setup,
}

impl Flavor {
    fn as_str(self) -> &'static str {
        match self {
            Self::Portable => "portable",
            Self::Setup => "setup",
        }
    }

    fn asset(self) -> &'static str {
        match self {
            Self::Portable => PORTABLE_ASSET,
            Self::Setup => SETUP_ASSET,
        }
    }

    fn checksum(self) -> String {
        format!("{}.sha256", self.asset())
    }
}

fn user_agent() -> String {
    format!("OneLedger/{APP_VERSION} (+https://github.com/{OWNER}/{REPO})")
}

fn parse_version(text: &str) -> Vec<u32> {
    let trimmed = text.trim().trim_start_matches(['v', 'V']);
    let take = trimmed
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .next()
        .unwrap_or("0");
    take.split('.').filter_map(|part| part.parse().ok()).collect()
}

fn version_gt(remote: &str, local: &str) -> bool {
    let a = parse_version(remote);
    let b = parse_version(local);
    let n = a.len().max(b.len());
    for i in 0..n {
        let left = *a.get(i).unwrap_or(&0);
        let right = *b.get(i).unwrap_or(&0);
        if left != right {
            return left > right;
        }
    }
    false
}

fn github_token() -> Option<String> {
    std::env::var("ONELEDGER_GITHUB_TOKEN")
        .ok()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn http_agent(use_proxy: bool, timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(timeout)
        .timeout_connect(Duration::from_secs(3))
        .try_proxy_from_env(use_proxy)
        .build()
}

fn cache_bust(url: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|item| item.as_millis())
        .unwrap_or(0);
    if url.contains('?') {
        format!("{url}&ol={ts}")
    } else {
        format!("{url}?ol={ts}")
    }
}

fn apply_headers(req: ureq::Request, accept: &str) -> ureq::Request {
    let req = req
        .set("User-Agent", &user_agent())
        .set("Accept", accept)
        .set("Cache-Control", "no-cache");
    match github_token() {
        Some(token) => req.set("Authorization", &format!("Bearer {token}")),
        None => req,
    }
}

fn request(url: &str, accept: &str, use_proxy: bool, timeout: Duration) -> Result<ureq::Response, String> {
    apply_headers(http_agent(use_proxy, timeout).get(url), accept)
        .call()
        .map_err(|err| err.to_string())
}

fn get_json_once(url: &str, use_proxy: bool) -> Result<Value, String> {
    request(&cache_bust(url), "application/json,text/plain,*/*", use_proxy, REQUEST_TIMEOUT)?
        .into_json()
        .map_err(|err| err.to_string())
}

fn get_bytes_once(url: &str, use_proxy: bool) -> Result<Vec<u8>, String> {
    let res = request(url, "*/*", use_proxy, DOWNLOAD_TIMEOUT)?;
    let mut out = Vec::new();
    res.into_reader().read_to_end(&mut out).map_err(|err| err.to_string())?;
    Ok(out)
}

fn get_bytes(url: &str) -> Result<Vec<u8>, String> {
    match get_bytes_once(url, false) {
        Ok(bytes) => Ok(bytes),
        Err(err) => match get_bytes_once(url, true) {
            Ok(bytes) => Ok(bytes),
            Err(proxy_err) => Err(format!("{err}；代理重试：{proxy_err}")),
        },
    }
}

fn host_of(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    let (auth_host, path) = rest.split_once('/')?;
    let host = auth_host.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    Some((host, format!("/{path}")))
}

fn validate_github_url(url: &str, initial: bool) -> Result<String, String> {
    let url = url.trim();
    let Some((host, path)) = host_of(url) else {
        return Err("更新地址必须是受信任的 GitHub HTTPS Release 资源".into());
    };
    let allowed = [
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    ];
    if !allowed.contains(&host.as_str()) {
        return Err("更新地址必须是受信任的 GitHub HTTPS Release 资源".into());
    }
    if initial && (host != "github.com" || !path.starts_with(&format!("/{OWNER}/{REPO}/releases/download/"))) {
        return Err("更新地址不属于 OneLedger 的 GitHub Release".into());
    }
    Ok(url.to_string())
}

fn normalize_channel(raw: &Value) -> Vec<Value> {
    let entries = if let Some(list) = raw.get("history").and_then(|v| v.as_array()) {
        list.clone()
    } else if let Some(list) = raw.as_array() {
        list.clone()
    } else if raw.is_object() {
        vec![raw.clone()]
    } else {
        vec![]
    };
    entries
        .into_iter()
        .filter_map(|item| {
            let version = item
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim_start_matches(['v', 'V'])
                .trim()
                .to_string();
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let notice = item.get("notice").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if version.is_empty() && title.is_empty() && body.is_empty() && notice.is_empty() {
                return None;
            }
            Some(json!({
                "version": version,
                "title": if title.is_empty() { format!("{version} 更新") } else { title },
                "body": body,
                "notice": notice
            }))
        })
        .collect()
}

fn embedded_channel() -> Vec<Value> {
    serde_json::from_str::<Value>(EMBEDDED_CHANNEL)
        .map(|raw| normalize_channel(&raw))
        .unwrap_or_default()
}

fn latest_of(history: &[Value]) -> String {
    history
        .first()
        .and_then(|item| item.get("version").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

fn is_canonical_source(url: &str, custom: &str) -> bool {
    let custom = custom.trim();
    if !custom.is_empty() && url == custom {
        return true;
    }
    let lower = url.to_ascii_lowercase();
    lower.contains("raw.githubusercontent.com") || (lower.contains("github.com/") && lower.contains("/raw/"))
}

fn channel_urls(update_url: &str) -> Vec<String> {
    let mut urls = Vec::new();
    if !update_url.trim().is_empty() {
        urls.push(update_url.trim().to_string());
    }
    for mirror in CHANNEL_MIRRORS {
        if !urls.iter().any(|item| item == mirror) {
            urls.push((*mirror).to_string());
        }
    }
    urls
}

struct ChannelHit {
    history: Vec<Value>,
    source: String,
}

fn fetch_one(url: &str, use_proxy: bool) -> Result<ChannelHit, String> {
    let history = normalize_channel(&get_json_once(url, use_proxy)?);
    if history.is_empty() {
        return Err(format!("{url} 通道为空"));
    }
    Ok(ChannelHit {
        history,
        source: url.to_string(),
    })
}

fn usable(hit: &ChannelHit, floor: &str) -> bool {
    !version_gt(floor, &latest_of(&hit.history))
}

fn better(a: &ChannelHit, b: &ChannelHit, custom: &str) -> bool {
    let av = latest_of(&a.history);
    let bv = latest_of(&b.history);
    if version_gt(&av, &bv) {
        return true;
    }
    if version_gt(&bv, &av) {
        return false;
    }
    is_canonical_source(&a.source, custom) && !is_canonical_source(&b.source, custom)
}

fn explain_channel_error(err: &str) -> String {
    if err.to_ascii_lowercase().contains("404") && github_token().is_none() {
        format!("{err}。GitHub 仓库若是私有的，未登录的检查会得到 404，这不是梯子问题。把仓库设为 Public，或设置环境变量 ONELEDGER_GITHUB_TOKEN。")
    } else {
        err.to_string()
    }
}

fn fetch_wave(urls: &[String], use_proxy: bool, floor: &str, custom: &str) -> Result<ChannelHit, String> {
    let (tx, rx) = mpsc::channel();
    for url in urls {
        let url = url.clone();
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(fetch_one(&url, use_proxy));
        });
    }
    drop(tx);
    let deadline = Instant::now() + CHANNEL_BUDGET;
    let mut best: Option<ChannelHit> = None;
    let mut last_err = "检查更新失败".to_string();
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            break;
        }
        match rx.recv_timeout(remain) {
            Ok(Ok(hit)) => {
                if !usable(&hit, floor) {
                    last_err = format!("{} 通道过期（{}）", hit.source, latest_of(&hit.history));
                    continue;
                }
                let canonical = is_canonical_source(&hit.source, custom);
                if best.as_ref().map(|cur| better(&hit, cur, custom)).unwrap_or(true) {
                    best = Some(hit);
                }
                if canonical {
                    break;
                }
            }
            Ok(Err(err)) => last_err = err,
            Err(_) => break,
        }
    }
    best.ok_or(last_err)
}

fn fetch_channel(update_url: &str) -> Result<(Vec<Value>, String), String> {
    let floor = latest_of(&embedded_channel());
    let urls = channel_urls(update_url);
    let custom = update_url.trim();
    match fetch_wave(&urls, false, &floor, custom) {
        Ok(hit) => Ok((hit.history, hit.source)),
        Err(err) if err.to_ascii_lowercase().contains("404") => Err(explain_channel_error(&err)),
        Err(direct_err) => match fetch_wave(&urls, true, &floor, custom) {
            Ok(hit) => Ok((hit.history, hit.source)),
            Err(proxy_err) => Err(explain_channel_error(&format!(
                "{direct_err}；系统代理重试：{proxy_err}"
            ))),
        },
    }
}

fn detect_flavor() -> Flavor {
    let Ok(exe) = std::env::current_exe() else {
        return Flavor::Portable;
    };
    let name = exe
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.contains("portable") {
        return Flavor::Portable;
    }
    let dir = exe.parent();
    if let Some(dir) = dir {
        let uninstall = ["uninstall.exe", "Uninstall.exe", "uninst.exe"]
            .iter()
            .any(|item| dir.join(item).is_file());
        if uninstall {
            return Flavor::Setup;
        }
    }
    let path = exe.to_string_lossy().to_ascii_lowercase();
    if path.contains("program files") || path.contains("\\program files (x86)\\") {
        return Flavor::Setup;
    }
    Flavor::Portable
}

fn can_hot_update() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()))
        .is_some_and(|name| name.contains("oneledger") && name.ends_with(".exe"))
}

fn release_download_url(tag: &str, name: &str) -> String {
    format!("https://github.com/{OWNER}/{REPO}/releases/download/{tag}/{name}")
}

fn constructed_download(tag: &str, html: &str, flavor: Flavor) -> Value {
    json!({
        "ok": true,
        "download_url": release_download_url(tag, flavor.asset()),
        "checksum_url": release_download_url(tag, &flavor.checksum()),
        "asset_name": flavor.asset(),
        "html_url": html
    })
}

fn resolve_download(version: &str, flavor: Flavor) -> Value {
    let tag = format!("v{}", version.trim_start_matches(['v', 'V']));
    let html = format!("https://github.com/{OWNER}/{REPO}/releases/tag/{tag}");
    constructed_download(&tag, &html, flavor)
}

pub fn check(update_url: &str) -> Value {
    let local = APP_VERSION;
    let flavor = detect_flavor();
    let (history, source) = match fetch_channel(update_url) {
        Ok(hit) => hit,
        Err(error) => {
            return json!({
                "ok": false,
                "current": local,
                "current_version": local,
                "flavor": flavor.as_str(),
                "asset_name": flavor.asset(),
                "can_hot_update": can_hot_update(),
                "html_url": RELEASES_PAGE,
                "source": "unreachable",
                "error": error,
                "message": format!("检查更新失败：{error}")
            })
        }
    };
    let latest = history
        .first()
        .and_then(|item| item.get("version").and_then(|v| v.as_str()))
        .unwrap_or(local)
        .to_string();
    let notes = history
        .first()
        .and_then(|item| item.get("body").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let notice = history
        .iter()
        .find_map(|item| item.get("notice").and_then(|v| v.as_str()).filter(|text| !text.is_empty()))
        .unwrap_or("")
        .to_string();
    let resolved = if latest.is_empty() {
        json!({"ok": false})
    } else {
        resolve_download(&latest, flavor)
    };
    let available = version_gt(&latest, local);
    let asset_ready = resolved.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    json!({
        "ok": true,
        "update": available,
        "update_available": available,
        "current": local,
        "current_version": local,
        "latest": latest,
        "latest_version": latest,
        "release_notes": notes,
        "notice": notice,
        "history": history,
        "flavor": flavor.as_str(),
        "asset_name": flavor.asset(),
        "html_url": resolved.get("html_url").cloned().unwrap_or(json!(RELEASES_PAGE)),
        "download_url": if asset_ready { resolved.get("download_url").cloned() } else { Some(Value::Null) },
        "checksum_url": if asset_ready { resolved.get("checksum_url").cloned() } else { Some(Value::Null) },
        "asset_ready": asset_ready,
        "asset_pending": resolved.get("pending").and_then(|v| v.as_bool()).unwrap_or(false),
        "asset_error": resolved.get("error").cloned().unwrap_or(Value::Null),
        "can_hot_update": can_hot_update(),
        "source": source,
        "message": if available {
            if asset_ready { format!("发现新版本 {latest}") } else { format!("发现新版本 {latest}，安装包尚未就绪") }
        } else {
            "已是最新版本".into()
        }
    })
}

fn parse_checksum(raw: &[u8], asset: &str) -> Result<String, String> {
    let text = String::from_utf8_lossy(raw);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let digest = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if digest.len() == 64 && Path::new(name).file_name().and_then(|v| v.to_str()) == Some(asset) {
            return Ok(digest.to_ascii_lowercase());
        }
    }
    Err(format!("校验清单里没有 {asset} 的 SHA-256"))
}

fn staging_paths(flavor: Flavor) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let base = match flavor {
        Flavor::Portable => std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .ok_or_else(|| "无法定位程序目录".to_string())?,
        Flavor::Setup => std::env::temp_dir(),
    };
    Ok((
        base.join(match flavor {
            Flavor::Portable => "OneLedger_update.exe",
            Flavor::Setup => "OneLedger-Setup.update.exe",
        }),
        base.join(match flavor {
            Flavor::Portable => "OneLedger_update.exe.partial",
            Flavor::Setup => "OneLedger-Setup.update.exe.partial",
        }),
        base.join("OneLedger_update.verify.json"),
    ))
}

pub fn download(update_url: &str) -> Value {
    if !can_hot_update() {
        return json!({"ok": false, "error": "热更新只用于打包后的桌面版。服务模式请到 Releases 手动下载。", "html_url": RELEASES_PAGE});
    }
    let flavor = detect_flavor();
    let info = check(update_url);
    if !info.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return info;
    }
    if !info.get("update_available").and_then(|v| v.as_bool()).unwrap_or(false) {
        return json!({"ok": false, "error": "当前已是最新版本，无需下载"});
    }
    let Some(download_url) = info.get("download_url").and_then(|v| v.as_str()) else {
        return json!({"ok": false, "error": info.get("asset_error").and_then(|v| v.as_str()).unwrap_or("安装包未就绪"), "html_url": info.get("html_url")});
    };
    let Some(checksum_url) = info.get("checksum_url").and_then(|v| v.as_str()) else {
        return json!({"ok": false, "error": "缺少校验文件"});
    };
    let download_url = match validate_github_url(download_url, true) {
        Ok(url) => url,
        Err(error) => return json!({"ok": false, "error": error}),
    };
    let checksum_url = match validate_github_url(checksum_url, true) {
        Ok(url) => url,
        Err(error) => return json!({"ok": false, "error": error}),
    };
    let expected = match get_bytes(&checksum_url).and_then(|raw| parse_checksum(&raw, flavor.asset())) {
        Ok(hash) => hash,
        Err(error) => return json!({"ok": false, "error": error}),
    };
    let blob = match get_bytes(&download_url) {
        Ok(bytes) => bytes,
        Err(error) => return json!({"ok": false, "error": format!("下载失败: {error}")}),
    };
    if blob.len() < 100 * 1024 {
        return json!({"ok": false, "error": "下载文件过小，可能不是有效安装包"});
    }
    let actual = hex::encode(Sha256::digest(&blob));
    if actual != expected {
        return json!({"ok": false, "error": format!("SHA-256 校验失败，已拒绝更新。期望 {expected}，实际 {actual}")});
    }
    let (dest, partial, meta) = match staging_paths(flavor) {
        Ok(paths) => paths,
        Err(error) => return json!({"ok": false, "error": error}),
    };
    if let Err(error) = fs::write(&partial, &blob) {
        return json!({"ok": false, "error": error.to_string()});
    }
    let _ = fs::remove_file(&dest);
    if let Err(error) = fs::rename(&partial, &dest) {
        return json!({"ok": false, "error": error.to_string()});
    }
    let _ = fs::write(
        meta,
        serde_json::to_vec_pretty(&json!({
            "version": info.get("latest_version"),
            "sha256": expected,
            "flavor": flavor.as_str(),
            "asset": flavor.asset()
        }))
        .unwrap_or_default(),
    );
    json!({
        "ok": true,
        "path": dest,
        "flavor": flavor.as_str(),
        "size": blob.len(),
        "sha256": expected,
        "latest_version": info.get("latest_version"),
        "message": match flavor {
            Flavor::Portable => format!("已下载便携包 {}，可立即替换并重启", info.get("latest_version").and_then(|v| v.as_str()).unwrap_or("")),
            Flavor::Setup => format!("已下载安装包 {}，可立即退出并运行安装程序", info.get("latest_version").and_then(|v| v.as_str()).unwrap_or("")),
        }
    })
}

pub fn apply() -> Value {
    if !can_hot_update() {
        return json!({"ok": false, "error": "热更新只用于打包后的桌面版。"});
    }
    let flavor = detect_flavor();
    let Ok((update_path, _, meta_path)) = staging_paths(flavor) else {
        return json!({"ok": false, "error": "无法定位更新包"});
    };
    if !update_path.is_file() {
        return json!({"ok": false, "error": "未找到已下载的更新包，请先下载更新"});
    }
    let Ok(meta) = fs::read_to_string(&meta_path) else {
        return json!({"ok": false, "error": "更新包缺少校验记录，请重新下载"});
    };
    let parsed: Value = serde_json::from_str(&meta).unwrap_or_default();
    if parsed.get("flavor").and_then(|v| v.as_str()) != Some(flavor.as_str()) {
        return json!({"ok": false, "error": "已下载的包和当前安装形态不一致，请重新检查更新"});
    }
    let expected = parsed.get("sha256").and_then(|s| s.as_str()).unwrap_or("");
    let Ok(bytes) = fs::read(&update_path) else {
        return json!({"ok": false, "error": "无法读取更新包"});
    };
    if hex::encode(Sha256::digest(&bytes)) != expected {
        return json!({"ok": false, "error": "更新包在下载后发生变化，已拒绝应用"});
    }
    let Ok(target) = std::env::current_exe() else {
        return json!({"ok": false, "error": "无法定位当前程序"});
    };
    let pid = std::process::id();
    let work = target.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let log = work.join("oneledger_update.log");
    let ps = std::env::temp_dir().join(format!("oneledger_apply_update_{pid}.ps1"));
    let upd = update_path.display().to_string().replace('\'', "''");
    let tgt = target.display().to_string().replace('\'', "''");
    let work_s = work.display().to_string().replace('\'', "''");
    let log_s = log.display().to_string().replace('\'', "''");
    let script = match flavor {
        Flavor::Portable => format!(
            r#"
$ErrorActionPreference = 'Continue'
$pidToWait = {pid}
$upd = '{upd}'
$tgt = '{tgt}'
$work = '{work_s}'
$log = '{log_s}'
function Write-Log($msg) {{
  $line = "[{{0}}] {{1}}" -f (Get-Date -Format o), $msg
  try {{ Add-Content -LiteralPath $log -Value $line -Encoding UTF8 }} catch {{}}
}}
Write-Log 'portable waiting'
try {{ Wait-Process -Id $pidToWait -Timeout 60 -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Seconds 1
if (Test-Path -LiteralPath $tgt) {{
  $old = "$tgt.old"
  try {{ if (Test-Path $old) {{ Remove-Item -LiteralPath $old -Force }} }} catch {{}}
  try {{ Rename-Item -LiteralPath $tgt -NewName (Split-Path $old -Leaf) }} catch {{ Write-Log $_ }}
}}
try {{
  Move-Item -LiteralPath $upd -Destination $tgt -Force
  Write-Log 'portable replaced'
  Start-Process -FilePath $tgt -WorkingDirectory $work
}} catch {{ Write-Log $_ }}
"#
        ),
        Flavor::Setup => format!(
            r#"
$ErrorActionPreference = 'Continue'
$pidToWait = {pid}
$upd = '{upd}'
$log = '{log_s}'
function Write-Log($msg) {{
  $line = "[{{0}}] {{1}}" -f (Get-Date -Format o), $msg
  try {{ Add-Content -LiteralPath $log -Value $line -Encoding UTF8 }} catch {{}}
}}
Write-Log 'setup waiting'
try {{ Wait-Process -Id $pidToWait -Timeout 60 -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Seconds 1
try {{
  Write-Log 'setup launching installer'
  Start-Process -FilePath $upd
}} catch {{ Write-Log $_ }}
"#
        ),
    };
    if fs::write(&ps, script).is_err() {
        return json!({"ok": false, "error": "无法写出更新助手脚本"});
    }
    let _ = crate::util::silent_command("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &ps.display().to_string()])
        .spawn();
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(400));
        std::process::exit(0);
    });
    json!({
        "ok": true,
        "flavor": flavor.as_str(),
        "message": match flavor {
            Flavor::Portable => "正在替换便携版并重启…",
            Flavor::Setup => "正在退出并打开安装程序…",
        }
    })
}

pub fn install(update_url: &str) -> Value {
    let downloaded = download(update_url);
    if !downloaded.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return downloaded;
    }
    let applied = apply();
    if !applied.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return applied;
    }
    json!({
        "ok": true,
        "flavor": applied.get("flavor"),
        "latest_version": downloaded.get("latest_version"),
        "message": match applied.get("flavor").and_then(|v| v.as_str()) {
            Some("setup") => "下载完成，即将退出并打开安装程序…",
            _ => "下载完成，即将替换并重启…",
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert!(version_gt("0.4.2", "0.4.1"));
        assert!(!version_gt("0.4.2", "0.4.2"));
        assert!(!version_gt("0.4.1", "0.4.2"));
    }

    #[test]
    fn github_raw_is_canonical() {
        assert!(is_canonical_source(DEFAULT_CHANNEL, ""));
        assert!(is_canonical_source(
            "https://github.com/Slocean/OneLedger/raw/main/app_update.json",
            ""
        ));
        assert!(!is_canonical_source(
            "https://cdn.jsdelivr.net/gh/Slocean/OneLedger@main/app_update.json",
            ""
        ));
        assert!(is_canonical_source(
            "https://example.com/latest.json",
            "https://example.com/latest.json"
        ));
    }

    #[test]
    fn stale_channel_is_not_usable() {
        let stale = ChannelHit {
            history: vec![json!({"version": "0.4.0", "title": "old", "body": "", "notice": ""})],
            source: "jsdelivr".into(),
        };
        assert!(!usable(&stale, "0.4.2"));
        let current = ChannelHit {
            history: vec![json!({"version": "0.4.2", "title": "now", "body": "", "notice": ""})],
            source: DEFAULT_CHANNEL.into(),
        };
        assert!(usable(&current, "0.4.2"));
        assert!(better(&current, &stale, ""));
    }
}
