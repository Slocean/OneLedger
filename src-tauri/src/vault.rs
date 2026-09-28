//! Local credential storage. MCP can manage metadata and propose writes with
//! desktop approval, but only the Tauri window can reveal a stored value.

use crate::http::AppState;
use crate::scan::verify_redacted;
use crate::store;
use crate::util::{hash_token, new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewWindow};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    id: String,
    label: String,
    scope_kind: String,
    scope_id: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInput {
    id: Option<String>,
    label: String,
    scope_kind: String,
    scope_id: String,
    value: String,
    expected_updated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultOrganizeInput {
    id: String,
    label: String,
    scope_kind: String,
    scope_id: String,
    expected_updated_at: String,
}

pub(crate) fn validate_window(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法验证窗口来源".to_string())?;
    let port = state.config.lock().map_err(|_| "无法验证窗口来源".to_string())?.port;
    if window.label() != "main"
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default() != Some(port)
    {
        return Err("凭据空间只能在 OneLedger 桌面窗口中使用".into());
    }
    Ok(())
}

fn validate_metadata(label: &str, scope_kind: &str, scope_id: &str) -> Result<(), String> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 80 || !label.chars().all(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '_' | '-' | '.')) {
        return Err("名称只能包含文字、数字、空格、点、横线和下划线，最多 80 字".into());
    }
    if !verify_redacted(label).is_empty() {
        return Err("名称不能包含凭据或个人信息".into());
    }
    match scope_kind {
        "project" if !scope_id.is_empty()
            && scope_id.chars().count() <= 120
            && scope_id.chars().all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.')) => {}
        "global" | "personal" if scope_id.is_empty() => {}
        _ => return Err("项目作用域必须填写仓库名，其他作用域不填写项目名".into()),
    }
    Ok(())
}

fn validate_input(input: &VaultInput) -> Result<(), String> {
    validate_metadata(&input.label, &input.scope_kind, &input.scope_id)?;
    if input.value.is_empty() || input.value.len() > 64 * 1024 {
        return Err("凭据原值不能为空，且不能超过 64 KiB".into());
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.starts_with("vault_") && id.len() <= 80 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        Ok(())
    } else {
        Err("凭据 ID 无效".into())
    }
}

fn next_updated_at(previous: &str) -> String {
    let now = now_iso();
    if now.as_str() > previous {
        return now;
    }
    chrono::DateTime::parse_from_rfc3339(previous)
        .map(|time| (time + chrono::Duration::milliseconds(1)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or(now)
}

fn list_items(conn: &Connection, scope_kind: Option<&str>, scope_id: Option<&str>, limit: i64, offset: i64) -> Result<Vec<VaultItem>, String> {
    let mut stmt = conn
        .prepare("SELECT id, label, scope_kind, scope_id, created_at, updated_at FROM vault_items WHERE (?1 IS NULL OR scope_kind = ?1) AND (?2 IS NULL OR scope_id = ?2) ORDER BY updated_at DESC, id DESC LIMIT ?3 OFFSET ?4")
        .map_err(|_| "无法读取凭据目录".to_string())?;
    let items = stmt.query_map(params![scope_kind, scope_id, limit.clamp(1, 200), offset.max(0)], row_item)
        .map_err(|_| "无法读取凭据目录".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "无法读取凭据目录".to_string())?;
    Ok(items)
}

fn row_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<VaultItem> {
    Ok(VaultItem {
        id: row.get("id")?,
        label: row.get("label")?,
        scope_kind: row.get("scope_kind")?,
        scope_id: row.get("scope_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn get_item(conn: &Connection, id: &str) -> rusqlite::Result<Option<(VaultItem, Vec<u8>)>> {
    conn.query_row(
        "SELECT id, label, scope_kind, scope_id, created_at, updated_at, protected_value FROM vault_items WHERE id = ?1",
        [id],
        |row| Ok((row_item(row)?, row.get("protected_value")?)),
    )
    .optional()
}

#[tauri::command]
pub fn vault_list(window: WebviewWindow, state: State<'_, AppState>) -> Result<Vec<VaultItem>, String> {
    validate_window(&window, &state)?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    list_items(&conn, None, None, 200, 0)
}

#[tauri::command]
pub fn vault_put(window: WebviewWindow, state: State<'_, AppState>, input: VaultInput) -> Result<VaultItem, String> {
    validate_window(&window, &state)?;
    validate_input(&input)?;
    let updating = input.id.is_some();
    let action = if updating { "替换" } else { "保存" };
    confirm(&window, &format!("确定{action}凭据「{}」吗？\n原值只保存在本机，Agent 无权读取。", input.label.trim()))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    put_item(&conn, input, "admin")
}

fn put_item(conn: &Connection, input: VaultInput, actor: &str) -> Result<VaultItem, String> {
    validate_input(&input)?;
    let updating = input.id.is_some();
    let id = input.id.unwrap_or_else(|| new_id("vault"));
    validate_id(&id)?;
    if !updating && input.expected_updated_at.is_some() {
        return Err("凭据已变化，请重新读取目录".into());
    }
    let protected = protect(&id, &input.value)?;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始保存".to_string())?;
    let (created_at, now) = if updating {
        let existing = get_item(&tx, &id).map_err(|_| "无法读取旧凭据".to_string())?.ok_or("凭据已不存在")?;
        if input.expected_updated_at.as_ref().is_some_and(|expected| expected != &existing.0.updated_at) {
            return Err("凭据已变化，请重新读取目录".into());
        }
        let now = next_updated_at(&existing.0.updated_at);
        tx.execute(
            "UPDATE vault_items SET label = ?1, scope_kind = ?2, scope_id = ?3, protected_value = ?4, updated_at = ?5 WHERE id = ?6",
            params![input.label.trim(), input.scope_kind, input.scope_id, protected, now, id],
        )
        .map_err(|_| "无法替换凭据".to_string())?;
        (existing.0.created_at, now)
    } else {
        let now = now_iso();
        tx.execute(
            "INSERT INTO vault_items (id, label, scope_kind, scope_id, protected_value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.label.trim(), input.scope_kind, input.scope_id, protected, now, now],
        )
        .map_err(|_| "无法保存凭据".to_string())?;
        (now.clone(), now)
    };
    store::audit(&tx, actor, if updating { "vault.replace" } else { "vault.create" }, &id)
        .map_err(|_| "无法记录操作".to_string())?;
    tx.commit().map_err(|_| "无法提交凭据".to_string())?;
    Ok(VaultItem {
        id,
        label: input.label.trim().into(),
        scope_kind: input.scope_kind,
        scope_id: input.scope_id,
        created_at,
        updated_at: now,
    })
}

#[tauri::command]
pub fn vault_organize(window: WebviewWindow, state: State<'_, AppState>, input: VaultOrganizeInput) -> Result<VaultItem, String> {
    validate_window(&window, &state)?;
    validate_metadata(&input.label, &input.scope_kind, &input.scope_id)?;
    validate_id(&input.id)?;
    let before = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        get_item(&conn, &input.id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0
    };
    confirm(&window, &format!("确定整理凭据「{}」的名称或作用域吗？\n原值不会被读取或修改。", before.label))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    organize_item(&conn, input, "admin")
}

fn organize_item(conn: &Connection, input: VaultOrganizeInput, actor: &str) -> Result<VaultItem, String> {
    validate_id(&input.id)?;
    validate_metadata(&input.label, &input.scope_kind, &input.scope_id)?;
    if input.expected_updated_at.is_empty() {
        return Err("请先读取当前凭据目录".into());
    }
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始整理".to_string())?;
    let before = get_item(&tx, &input.id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0;
    if before.updated_at != input.expected_updated_at {
        return Err("凭据已变化，请重新读取目录".into());
    }
    let now = next_updated_at(&before.updated_at);
    let changed = tx.execute(
        "UPDATE vault_items SET label = ?1, scope_kind = ?2, scope_id = ?3, updated_at = ?4 WHERE id = ?5 AND updated_at = ?6",
        params![input.label.trim(), input.scope_kind, input.scope_id, now, input.id, input.expected_updated_at],
    ).map_err(|_| "无法整理凭据".to_string())?;
    if changed != 1 {
        return Err("凭据已变化，请重新读取目录".into());
    }
    store::audit(&tx, actor, "vault.organize", &input.id).map_err(|_| "无法记录整理操作".to_string())?;
    tx.commit().map_err(|_| "无法提交整理".to_string())?;
    Ok(VaultItem { id: input.id, label: input.label.trim().into(), scope_kind: input.scope_kind, scope_id: input.scope_id, created_at: before.created_at, updated_at: now })
}

#[tauri::command]
pub fn vault_reveal(window: WebviewWindow, state: State<'_, AppState>, id: String) -> Result<String, String> {
    validate_window(&window, &state)?;
    let before = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        get_item(&conn, &id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0
    };
    confirm(&window, &format!("确定现在查看凭据「{}」的原值吗？\n仅在当前窗口短暂显示。", before.label))?;
    let protected = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        let (current, blob) = get_item(&conn, &id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?;
        if current.updated_at != before.updated_at {
            return Err("凭据已变化，请重新确认".into());
        }
        store::audit(&conn, "admin", "vault.reveal", &id).map_err(|_| "无法记录查看操作".to_string())?;
        blob
    };
    unprotect(&id, &protected)
}

#[tauri::command]
pub fn vault_delete(window: WebviewWindow, state: State<'_, AppState>, id: String) -> Result<(), String> {
    validate_window(&window, &state)?;
    validate_id(&id)?;
    let before = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        get_item(&conn, &id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0
    };
    confirm(&window, &format!("确定永久删除凭据「{}」吗？\n这项操作不能撤销。", before.label))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    delete_item(&conn, &id, &before.updated_at, "admin")
}

#[tauri::command]
pub fn key_reveal(window: WebviewWindow, state: State<'_, AppState>, id: String) -> Result<String, String> {
    validate_window(&window, &state)?;
    if !id.starts_with("key_") || id.len() > 80 || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return Err("Agent 密钥 ID 无效".into());
    }
    let key = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        store::find_key_by_id(&conn, &id).map_err(|_| "无法读取 Agent 密钥".to_string())?.ok_or("Agent 密钥已不存在")?
    };
    let protected = key.protected_token.ok_or("这把旧密钥只保存了哈希，无法恢复原值；现有连接继续有效")?;
    confirm_with_title(&window, "OneLedger Agent 密钥确认", &format!("确定查看 Agent 密钥「{}」的完整值吗？\n仅在当前桌面窗口短暂显示。", key.name))?;
    let token = unprotect_key(&id, &protected)?;
    if hash_token(&token) != key.token_hash {
        return Err("Agent 密钥校验失败".into());
    }
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    store::audit(&conn, "admin", "key.reveal", &id).map_err(|_| "无法记录查看操作".to_string())?;
    Ok(token)
}

fn delete_item(conn: &Connection, id: &str, expected_updated_at: &str, actor: &str) -> Result<(), String> {
    validate_id(id)?;
    if expected_updated_at.is_empty() {
        return Err("请先读取当前凭据目录".into());
    }
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始删除".to_string())?;
    let removed = tx.execute("DELETE FROM vault_items WHERE id = ?1 AND updated_at = ?2", params![id, expected_updated_at])
        .map_err(|_| "无法删除凭据".to_string())?;
    if removed != 1 {
        return Err("凭据已变化，请重新确认".into());
    }
    store::audit(&tx, actor, "vault.delete", id).map_err(|_| "无法记录删除操作".to_string())?;
    tx.commit().map_err(|_| "无法提交删除".to_string())?;
    Ok(())
}

pub(crate) fn agent_window(state: &AppState) -> Result<WebviewWindow, String> {
    let window = state.app_handle.get_webview_window("main").ok_or("请先打开 OneLedger 桌面窗口")?;
    validate_window(&window, state)?;
    Ok(window)
}

fn actor_label(actor: &str) -> String {
    let label: String = actor.chars()
        .filter(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '_' | '-' | '.'))
        .take(40)
        .collect();
    if label.is_empty() { "Agent".into() } else { label }
}

pub fn agent_list(state: &AppState, actor: &str, scope_kind: Option<&str>, scope_id: Option<&str>, limit: i64, offset: i64) -> Result<Vec<VaultItem>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    let items = list_items(&conn, scope_kind, scope_id, limit, offset)?;
    store::audit(&conn, &format!("mcp:{actor}"), "vault.list", "metadata only")
        .map_err(|_| "无法记录目录操作".to_string())?;
    Ok(items)
}

pub fn agent_put(state: &AppState, actor: &str, input: VaultInput) -> Result<VaultItem, String> {
    validate_input(&input)?;
    if input.id.is_some() && input.expected_updated_at.is_none() {
        return Err("替换凭据前请先读取目录并传入 expectedUpdatedAt".into());
    }
    let _approval = state.vault_approval.lock().map_err(|_| "确认窗口不可用".to_string())?;
    let window = agent_window(state)?;
    let destination = if input.scope_kind == "project" { format!("project / {}", input.scope_id) } else { input.scope_kind.clone() };
    let details = if let Some(id) = input.id.as_deref() {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        let before = get_item(&conn, id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0;
        if input.expected_updated_at.as_deref() != Some(before.updated_at.as_str()) {
            return Err("凭据已变化，请重新读取目录".into());
        }
        format!("替换「{}」为「{}」，作用域：{}", before.label, input.label.trim(), destination)
    } else {
        format!("保存「{}」，作用域：{}", input.label.trim(), destination)
    };
    confirm(&window, &format!("Agent「{}」请求{details}。\n同意后原值将在本机加密保存；MCP 不会返回原值。", actor_label(actor)))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    put_item(&conn, input, &format!("mcp:{actor}"))
}

pub fn agent_organize(state: &AppState, actor: &str, input: VaultOrganizeInput) -> Result<VaultItem, String> {
    validate_id(&input.id)?;
    validate_metadata(&input.label, &input.scope_kind, &input.scope_id)?;
    let _approval = state.vault_approval.lock().map_err(|_| "确认窗口不可用".to_string())?;
    let window = agent_window(state)?;
    let before = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        get_item(&conn, &input.id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0
    };
    if before.updated_at != input.expected_updated_at {
        return Err("凭据已变化，请重新读取目录".into());
    }
    confirm(&window, &format!("Agent「{}」请求整理凭据「{}」。\n新名称：「{}」，新作用域：{} {}。\n原值不会被读取或修改。", actor_label(actor), before.label, input.label.trim(), input.scope_kind, input.scope_id))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    organize_item(&conn, input, &format!("mcp:{actor}"))
}

pub fn agent_delete(state: &AppState, actor: &str, id: &str, expected_updated_at: &str) -> Result<(), String> {
    validate_id(id)?;
    let _approval = state.vault_approval.lock().map_err(|_| "确认窗口不可用".to_string())?;
    let window = agent_window(state)?;
    let before = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        get_item(&conn, id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0
    };
    if before.updated_at != expected_updated_at {
        return Err("凭据已变化，请重新读取目录".into());
    }
    confirm(&window, &format!("Agent「{}」请求永久删除凭据「{}」。\n这项操作不能撤销。", actor_label(actor), before.label))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    delete_item(&conn, id, expected_updated_at, &format!("mcp:{actor}"))
}

#[cfg(windows)]
fn confirm(window: &WebviewWindow, message: &str) -> Result<(), String> {
    confirm_with_title(window, "OneLedger 凭据确认", message)
}

#[cfg(windows)]
pub(crate) fn confirm_with_title(window: &WebviewWindow, title: &str, message: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO};
    let handle = window.hwnd().map_err(|_| "无法打开确认窗口".to_string())?;
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let answer = unsafe { MessageBoxW(handle.0, text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) };
    if answer == IDYES { Ok(()) } else { Err("操作已取消".into()) }
}

#[cfg(not(windows))]
fn confirm(_window: &WebviewWindow, _message: &str) -> Result<(), String> {
    Err("当前系统尚不支持本机凭据空间".into())
}

#[cfg(not(windows))]
pub(crate) fn confirm_with_title(_window: &WebviewWindow, _title: &str, _message: &str) -> Result<(), String> {
    Err("当前系统尚不支持本机确认窗口".into())
}

pub(crate) fn protect_key(id: &str, token: &str) -> Result<Vec<u8>, String> {
    protect(&format!("mcp-key:{id}"), token)
}

pub(crate) fn unprotect_key(id: &str, protected: &[u8]) -> Result<String, String> {
    unprotect(&format!("mcp-key:{id}"), protected)
}

#[cfg(windows)]
fn protect(id: &str, value: &str) -> Result<Vec<u8>, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let mut bytes = value.as_bytes().to_vec();
    let mut entropy = format!("OneLedger:vault:v1:{id}").into_bytes();
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_mut_ptr() };
    let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe { CryptProtectData(&input, null(), &extra, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
    bytes.fill(0);
    if ok == 0 {
        return Err("Windows 无法保护凭据".into());
    }
    let protected = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()); }
    Ok(protected)
}

#[cfg(windows)]
fn unprotect(id: &str, protected: &[u8]) -> Result<String, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
    let mut bytes = protected.to_vec();
    let mut entropy = format!("OneLedger:vault:v1:{id}").into_bytes();
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_mut_ptr() };
    let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), &extra, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
    if ok == 0 {
        return Err("无法解锁凭据；请确认使用的是保存时的 Windows 用户".into());
    }
    let plain = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(output.pbData.cast());
    }
    String::from_utf8(plain).map_err(|_| "凭据编码无效".into())
}

#[cfg(not(windows))]
fn protect(_id: &str, _value: &str) -> Result<Vec<u8>, String> {
    Err("当前系统尚不支持本机凭据空间".into())
}

#[cfg(not(windows))]
fn unprotect(_id: &str, _protected: &[u8]) -> Result<String, String> {
    Err("当前系统尚不支持本机凭据空间".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch("CREATE TABLE vault_items (id TEXT PRIMARY KEY, label TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, protected_value BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE audit_log (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);").expect("schema");
        conn
    }

    #[test]
    fn vault_input_requires_repo_name_and_never_accepts_secret_in_label() {
        let input = VaultInput { id: None, label: "生产 API".into(), scope_kind: "project".into(), scope_id: "CofoeAirLink_Web".into(), value: "fake-test-value".into(), expected_updated_at: None };
        assert!(validate_input(&input).is_ok());
        let bad_scope = VaultInput { scope_id: "src/config.ts".into(), ..input };
        assert!(validate_input(&bad_scope).is_err());
        let bad_label = VaultInput { label: "sk-abcdefghijklmnopqrstuvwxyz123456".into(), scope_id: "CofoeAirLink_Web".into(), ..bad_scope };
        assert!(validate_input(&bad_label).is_err());
    }

    #[test]
    fn organize_preserves_ciphertext_and_rejects_stale_revision() {
        let conn = test_db();
        let blob = vec![7_u8, 0, 19, 255];
        conn.execute("INSERT INTO vault_items VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params!["vault_test_1", "旧名称", "project", "OneLedger", blob, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]).expect("insert");
        let input = VaultOrganizeInput { id: "vault_test_1".into(), label: "新名称".into(), scope_kind: "global".into(), scope_id: "".into(), expected_updated_at: "2026-09-01T00:00:00.000Z".into() };
        let updated = organize_item(&conn, input, "mcp:test").expect("organize");
        assert_eq!(updated.scope_kind, "global");
        assert!(updated.updated_at.as_str() > "2026-09-01T00:00:00.000Z");
        assert_eq!(get_item(&conn, "vault_test_1").expect("get").unwrap().1, vec![7_u8, 0, 19, 255]);
        let stale = VaultOrganizeInput { id: "vault_test_1".into(), label: "错误覆盖".into(), scope_kind: "personal".into(), scope_id: "".into(), expected_updated_at: "2026-09-01T00:00:00.000Z".into() };
        assert!(organize_item(&conn, stale, "mcp:test").is_err());
        assert!(delete_item(&conn, "vault_test_1", "2026-09-01T00:00:00.000Z", "mcp:test").is_err());
        assert_eq!(get_item(&conn, "vault_test_1").expect("get").unwrap().0.label, "新名称");
    }

    #[cfg(windows)]
    #[test]
    fn protected_value_is_user_bound_and_item_bound() {
        let marker = "constructed-secret-for-test-47";
        let encrypted = protect("vault_test_1", marker).expect("protect");
        assert!(!encrypted.windows(marker.len()).any(|part| part == marker.as_bytes()));
        assert_eq!(unprotect("vault_test_1", &encrypted).expect("unprotect"), marker);
        assert!(unprotect("vault_test_2", &encrypted).is_err());
    }
}
