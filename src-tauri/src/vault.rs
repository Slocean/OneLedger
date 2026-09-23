//! Local credential storage. Values are protected by the current Windows user,
//! and deliberately have no HTTP, MCP, collector, or sync entry point.

use crate::http::AppState;
use crate::scan::verify_redacted;
use crate::store;
use crate::util::{new_id, now_iso};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInput {
    id: Option<String>,
    label: String,
    scope_kind: String,
    scope_id: String,
    value: String,
}

fn validate_window(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
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

fn validate_input(input: &VaultInput) -> Result<(), String> {
    let label = input.label.trim();
    if label.is_empty() || label.chars().count() > 80 || !label.chars().all(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '_' | '-' | '.')) {
        return Err("名称只能包含文字、数字、空格、点、横线和下划线，最多 80 字".into());
    }
    if !verify_redacted(label).is_empty() {
        return Err("名称不能包含凭据或个人信息".into());
    }
    match input.scope_kind.as_str() {
        "project" if !input.scope_id.is_empty()
            && input.scope_id.chars().count() <= 120
            && input.scope_id.chars().all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.')) => {}
        "global" | "personal" if input.scope_id.is_empty() => {}
        _ => return Err("项目作用域必须填写仓库名，其他作用域不填写项目名".into()),
    }
    if input.value.is_empty() || input.value.len() > 64 * 1024 {
        return Err("凭据原值不能为空，且不能超过 64 KiB".into());
    }
    Ok(())
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
    let mut stmt = conn
        .prepare("SELECT id, label, scope_kind, scope_id, created_at, updated_at FROM vault_items ORDER BY updated_at DESC LIMIT 200")
        .map_err(|_| "无法读取凭据目录".to_string())?;
    let items = stmt.query_map([], row_item)
        .map_err(|_| "无法读取凭据目录".to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "无法读取凭据目录".to_string())?;
    Ok(items)
}

#[tauri::command]
pub fn vault_put(window: WebviewWindow, state: State<'_, AppState>, input: VaultInput) -> Result<VaultItem, String> {
    validate_window(&window, &state)?;
    validate_input(&input)?;
    let updating = input.id.is_some();
    let action = if updating { "替换" } else { "保存" };
    confirm(&window, &format!("确定{action}凭据「{}」吗？\n原值只保存在本机，Agent 无权读取。", input.label.trim()))?;

    let id = input.id.unwrap_or_else(|| new_id("vault"));
    let protected = protect(&id, &input.value)?;
    let now = now_iso();
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始保存".to_string())?;
    let created_at = if updating {
        let existing = get_item(&tx, &id).map_err(|_| "无法读取旧凭据".to_string())?.ok_or("凭据已不存在")?;
        tx.execute(
            "UPDATE vault_items SET label = ?1, scope_kind = ?2, scope_id = ?3, protected_value = ?4, updated_at = ?5 WHERE id = ?6",
            params![input.label.trim(), input.scope_kind, input.scope_id, protected, now, id],
        )
        .map_err(|_| "无法替换凭据".to_string())?;
        existing.0.created_at
    } else {
        tx.execute(
            "INSERT INTO vault_items (id, label, scope_kind, scope_id, protected_value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, input.label.trim(), input.scope_kind, input.scope_id, protected, now, now],
        )
        .map_err(|_| "无法保存凭据".to_string())?;
        now.clone()
    };
    store::audit(&tx, "admin", if updating { "vault.replace" } else { "vault.create" }, &id)
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
    let before = {
        let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
        get_item(&conn, &id).map_err(|_| "无法读取凭据".to_string())?.ok_or("凭据已不存在")?.0
    };
    confirm(&window, &format!("确定永久删除凭据「{}」吗？\n这项操作不能撤销。", before.label))?;
    let conn = state.conn.lock().map_err(|_| "数据库不可用".to_string())?;
    let tx = conn.unchecked_transaction().map_err(|_| "无法开始删除".to_string())?;
    let removed = tx.execute("DELETE FROM vault_items WHERE id = ?1 AND updated_at = ?2", params![id, before.updated_at])
        .map_err(|_| "无法删除凭据".to_string())?;
    if removed != 1 {
        return Err("凭据已变化，请重新确认".into());
    }
    store::audit(&tx, "admin", "vault.delete", &id).map_err(|_| "无法记录删除操作".to_string())?;
    tx.commit().map_err(|_| "无法提交删除".to_string())?;
    Ok(())
}

#[cfg(windows)]
fn confirm(window: &WebviewWindow, message: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO};
    let handle = window.hwnd().map_err(|_| "无法打开确认窗口".to_string())?;
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "OneLedger 凭据确认".encode_utf16().chain(Some(0)).collect();
    let answer = unsafe { MessageBoxW(handle.0, text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) };
    if answer == IDYES { Ok(()) } else { Err("操作已取消".into()) }
}

#[cfg(not(windows))]
fn confirm(_window: &WebviewWindow, _message: &str) -> Result<(), String> {
    Err("当前系统尚不支持本机凭据空间".into())
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

    #[test]
    fn vault_input_requires_repo_name_and_never_accepts_secret_in_label() {
        let input = VaultInput { id: None, label: "生产 API".into(), scope_kind: "project".into(), scope_id: "CofoeAirLink_Web".into(), value: "fake-test-value".into() };
        assert!(validate_input(&input).is_ok());
        let bad_scope = VaultInput { scope_id: "src/config.ts".into(), ..input };
        assert!(validate_input(&bad_scope).is_err());
        let bad_label = VaultInput { label: "sk-abcdefghijklmnopqrstuvwxyz123456".into(), scope_id: "CofoeAirLink_Web".into(), ..bad_scope };
        assert!(validate_input(&bad_label).is_err());
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
