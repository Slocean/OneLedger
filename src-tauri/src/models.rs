use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub rev: i64,
    pub title: String,
    pub body: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub sensitivity: String,
    pub status: String,
    pub source: String,
    pub origin_node: String,
    pub content_hash: String,
    pub superseded_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub forgotten_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxRecord {
    pub id: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub scope_kind: String,
    pub scope_id: String,
    pub sensitivity: String,
    pub redacted: i64,
    pub queue_status: String,
    pub conflict_ids: Vec<String>,
    pub created_at: String,
    /// 稳定来源键（规范化绝对路径等）；空串表示人工创建或 v12 之前的历史行。
    /// 同仓库不同文件同文时靠它区分，不再把其他文件的相同正文当唯一依据（B-05）。
    #[serde(default)]
    pub source_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub builtin: bool,
    pub enabled: bool,
    pub root_path: String,
    pub last_scanned_at: Option<String>,
    pub last_scanned_files: i64,
    pub last_ingested: i64,
    pub last_queued: i64,
    pub last_redacted: i64,
    pub last_error: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyRecord {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub token_prefix: String,
    #[serde(skip_serializing)]
    pub protected_token: Option<Vec<u8>>,
    pub scopes: String,
    pub tools: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedMcpSourceRecord {
    pub key_id: String,
    pub key_name: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectResult {
    pub source: String,
    pub scanned_files: i64,
    pub ingested: i64,
    pub queued: i64,
    pub skipped: i64,
    pub redacted: i64,
    /// 事务失败（含采集指纹登记失败）而本轮未处理的文件数；失败文件不写指纹，下一轮重扫重试。
    #[serde(default)]
    pub errors: i64,
}
