const TOKEN_KEY = "oneledger.adminToken";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("x-admin-token", getToken());
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ version: string; home: string }>("/api/health"),
  status: () =>
    request<{
      version: string;
      role: string;
      storage: string;
      bind: string;
      counts: { active: number; inbox: number };
      collecting?: boolean;
      collect?: CollectStatus;
    }>("/api/status"),
  config: () => request<Record<string, unknown>>("/api/config"),
  saveConfig: (body: unknown) => request<{ ok: boolean }>("/api/config", { method: "PUT", body: JSON.stringify(body) }),
  memories: (scope?: { scopeKind: string; scopeId?: string }) =>
    request<{ memories: Memory[] }>(scope
      ? `/api/memories?${new URLSearchParams({ scopeKind: scope.scopeKind, scopeId: scope.scopeId ?? "" })}`
      : "/api/memories"),
  exportMemories: () =>
    request<{ name: string; version: string; exportedAt: string; count: number; memories: Memory[] }>(
      "/api/memories/export",
    ),
  async backupExport(): Promise<string> {
    const response = await fetch("/api/backup/export", { headers: { "x-admin-token": getToken() } });
    if (!response.ok) {
      throw new Error((await response.text()) || `${response.status}`);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] ?? "OneLedger-Backup.json";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return filename;
  },
  backupImport: (body: unknown) =>
    request<{ ok: boolean; applied: Record<string, number>; skipped: Record<string, number> }>("/api/backup/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remember: (body: string, opts?: { title?: string; scopeKind?: string; scopeId?: string; expectedRev?: number }) =>
    request<{ status: string; inboxId: string; memoryId?: string; redacted: boolean; queued: boolean; currentRev?: number; hits?: Array<{ type: string; field?: string; line?: number }> }>("/api/remember", {
      method: "POST",
      body: JSON.stringify({
        body,
        title: opts?.title,
        scopeKind: opts?.scopeKind,
        scopeId: opts?.scopeId,
        expectedRev: opts?.expectedRev,
      }),
    }),
  queueCustom: (body: string, title?: string) =>
    request<{ inboxId: string; queued: boolean }>("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ body, title }),
    }),
  reject: (id: string) => request<{ ok: boolean }>(`/api/inbox/${id}/reject`, { method: "POST" }),
  resolveInbox: (ids: string[], body: string, title: string, expectedRev: number, opts?: { draftId?: string }) =>
    request<ResolveResult>("/api/inbox/resolve", {
      method: "POST",
      body: JSON.stringify({ ids, body, title, expectedRev, draftId: opts?.draftId }),
    }),
  updates: () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
    return request<UpdateInfo>("/api/updates", { signal: controller.signal }).finally(() =>
      window.clearTimeout(timer),
    );
  },
  installUpdate: () =>
    request<{ ok: boolean; message?: string; error?: string; html_url?: string }>("/api/updates/install", {
      method: "POST",
    }),
  inbox: (
    status: "proposed" | "rejected" = "proposed",
    opts?: { scopeKind?: string; scopeId?: string; source?: string; limit?: number; offset?: number; ids?: string[]; draftId?: string },
  ) => {
    const params = new URLSearchParams({ status });
    if (opts?.scopeKind) params.set("scopeKind", opts.scopeKind);
    if (opts?.scopeId) params.set("scopeId", opts.scopeId);
    if (opts?.source) params.set("source", opts.source);
    if (opts?.ids?.length) params.set("ids", opts.ids.join(","));
    if (opts?.draftId) params.set("draftId", opts.draftId);
    params.set("limit", String(opts?.limit ?? 50));
    params.set("offset", String(opts?.offset ?? 0));
    return request<{ inbox: Inbox[]; total: number; limit: number; offset: number; hasMore: boolean }>(
      `/api/inbox?${params.toString()}`,
    );
  },
  pruneHistory: () => request<{ ok: boolean; archivedEvents: number; removedRejected: number }>("/api/history/prune", { method: "POST" }),
  distillTasks: (opts?: { query?: string; abnormal?: boolean; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.query) params.set("query", opts.query);
    if (opts?.abnormal) params.set("abnormal", "1");
    params.set("limit", String(opts?.limit ?? 30));
    params.set("offset", String(opts?.offset ?? 0));
    return request<{ tasks: DistillTask[]; total: number; limit: number; offset: number; hasMore: boolean; provider: string; model: string }>(
      `/api/distill/tasks?${params.toString()}`,
    );
  },
  distillDraft: (scopeKind: string, scopeId: string, sourceIds: string[]) =>
    request<{ status: string; draft?: DistillDraft; error?: string; blocked?: string[]; attempts?: number }>("/api/distill/draft", {
      method: "POST",
      body: JSON.stringify({ scopeKind, scopeId, sourceIds }),
    }),
  discardDraft: (id: string) => request<{ ok: boolean }>(`/api/distill/draft/${id}/discard`, { method: "POST" }),
  mergePreview: (fromScopeId: string, toScopeId: string, fromScopeKind = "project") =>
    request<ScopeMergePreview>("/api/scopes/merge/preview", {
      method: "POST",
      body: JSON.stringify({ fromScopeKind, fromScopeId, toScopeId }),
    }),
  /** B-07：确认只归并管理员显式勾选、经核对的精确 ID 子集。 */
  mergeConfirm: (fromScopeId: string, toScopeId: string, digest: string, ids: string[], fromScopeKind = "project") =>
    request<ScopeMergeResult>("/api/scopes/merge/confirm", {
      method: "POST",
      body: JSON.stringify({ fromScopeKind, fromScopeId, toScopeId, digest, ids }),
    }),
  mergeRevert: (operationId: string) =>
    request<ScopeMergeRevert>("/api/scopes/merge/revert", { method: "POST", body: JSON.stringify({ operationId }) }),
  mergeOperations: (offset = 0) =>
    request<{ operations: ScopeMergeOperationRow[]; total: number }>(`/api/scopes/merge/operations?limit=20&offset=${offset}`),
  fingerprintReport: () =>
    request<{ status: string; note: string; operations: Array<Record<string, unknown>> }>("/api/scopes/merge/fingerprint-report"),
  audit: () => request<{ audit: Audit[]; redactions: Redaction[] }>("/api/audit"),
  collect: () => request<{ results: Collect[] }>("/api/collect", { method: "POST" }),
  agents: () => request<{ agents: AgentRow[] }>("/api/agents"),
  createAgent: (name: string, rootPath: string) =>
    request<{ agent: AgentRow }>("/api/agents", { method: "POST", body: JSON.stringify({ name, rootPath }) }),
  updateAgent: (id: string, patch: { enabled?: boolean; rootPath?: string; name?: string }) =>
    request<{ agent: AgentRow }>(`/api/agents/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteAgent: (id: string) => request<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),
  collectAgent: (id: string) => request<{ result: Collect }>(`/api/agents/${id}/collect`, { method: "POST" }),
  sync: () => request<SyncReport>("/api/sync", { method: "POST" }),
  keys: () => request<{ keys: KeyRow[] }>("/api/keys"),
  createKey: (name: string) =>
    request<{ id: string; token: string; name: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name }) }),
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  }
}

function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return Promise.reject(new Error("此操作只能在 OneLedger 的 Tauri 窗口中使用"));
  return invoke<T>(command, args);
}

export const keyApi = {
  reveal: (id: string) => desktopInvoke<string>("key_reveal", { id }),
  trustedSources: () => desktopInvoke<TrustedMcpSourceRow[]>("trusted_mcp_sources_list"),
  forgetSource: (keyId: string, source: string) => desktopInvoke<void>("trusted_mcp_sources_forget", { keyId, source }),
};

export interface TrustedMcpSourceRow {
  keyId: string;
  keyName: string;
  source: string;
  createdAt: string;
}

export interface VaultItem {
  id: string;
  label: string;
  scopeKind: "global" | "project" | "personal";
  scopeId: string;
  createdAt: string;
  updatedAt: string;
}

export const vaultApi = {
  list: () => desktopInvoke<VaultItem[]>("vault_list"),
  put: (input: { id?: string; label: string; scopeKind: VaultItem["scopeKind"]; scopeId: string; value: string; expectedUpdatedAt?: string }) =>
    desktopInvoke<VaultItem>("vault_put", { input }),
  organize: (input: { id: string; label: string; scopeKind: VaultItem["scopeKind"]; scopeId: string; expectedUpdatedAt: string }) =>
    desktopInvoke<VaultItem>("vault_organize", { input }),
  reveal: (id: string) => desktopInvoke<string>("vault_reveal", { id }),
  delete: (id: string) => desktopInvoke<void>("vault_delete", { id }),
};

export interface CollectStatus {
  running: boolean;
  phase?: string;
  currentAgent?: string;
  message?: string;
}

export interface Memory {
  id: string;
  rev?: number;
  title: string;
  body: string;
  scopeKind: string;
  scopeId?: string;
  source: string;
  updatedAt: string;
  sensitivity: string;
}

export interface Inbox {
  id: string;
  title: string;
  body: string;
  source: string;
  scopeKind?: string;
  scopeId?: string;
  sensitivity: string;
  /** 与后端一致：整数（0/1）。Rust API 返回整数；前端只做真值判断。 */
  redacted?: number;
  createdAt: string;
  queueStatus: string;
  conflictIds: string[];
  hits?: string[];
}

/** /api/inbox/resolve 的结果：conflict 时前端必须进入阻断合并，不得直接改用 currentRev 重试。 */
export interface ResolveResult {
  status: "stored" | "unchanged" | "conflict" | "rejected" | "error";
  memoryId?: string;
  rev?: number;
  currentRev?: number;
  error?: string;
  draftId?: string;
  hits?: Array<{ type: string; field?: string; line?: number }>;
}

export interface DistillDraft {
  id: string;
  scopeKind: string;
  scopeId: string;
  title: string;
  body: string;
  sourceIds: string[];
  sourceFingerprints: string[];
  expectedRev: number;
  provider: string;
  model: string;
  status: string;
  staleReason: string;
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface DistillTask {
  scopeKind: string;
  scopeId: string;
  pending: number;
  oldestWaitingAt?: string;
  workbuddy: number;
  abnormal: boolean;
  draft?: DistillDraft;
  lastResult?: { status: string; error: string; attempts: number; at: string };
}

export interface ScopeMergePreview {
  status: string;
  error?: string;
  fromScopeId?: string;
  toScopeId?: string;
  pending?: number;
  /** 本批将移动的条数（≤ batchLimit）。 */
  batch?: number;
  /** 本批之后来源作用域剩余的待处理条数。 */
  remaining?: number;
  batchLimit?: number;
  sourceBreakdown?: Array<{ source: string; count: number }>;
  /** 来源分布截断说明（top20 之外）。 */
  otherCount?: number;
  otherKinds?: number;
  /** 本批全部条目的脱敏元数据（≤1000 条），供逐条核对归属并勾选子集（B-07）。 */
  batchItems?: Array<{ id: string; title: string; source: string; createdAt: string; sensitivity: string }>;
  toPending?: number;
  toMemory?: { id: string; rev: number; updatedAt: string } | null;
  drafts?: Array<{ scopeId: string; id: string; status: string; updatedAt: string; staleReason: string }>;
  blocked?: string[];
  digest?: string;
}

export interface ScopeMergeResult {
  status: "applied" | "conflict" | "blocked" | "error" | "unsupported";
  operationId?: string;
  moved?: number;
  toScopeId?: string;
  /** applied 后来源作用域剩余的待处理条数。 */
  remaining?: number;
  error?: string;
  preview?: ScopeMergePreview;
}

export interface ScopeMergeRevert {
  status: "reverted" | "already-reverted" | "conflict" | "error" | "unsupported";
  operationId?: string;
  reverted?: number;
  error?: string;
}

export interface ScopeMergeOperationRow {
  id: string;
  fromScopeKind: string;
  fromScopeId: string;
  toScopeKind: string;
  toScopeId: string;
  movedCount: number;
  sourceBreakdown: Record<string, number>;
  status: string;
  createdAt: string;
  revertedAt: string | null;
}

export interface Audit {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface Redaction {
  at: string;
  source: string;
  hit_type: string;
}

export interface Collect {
  source: string;
  scannedFiles: number;
  ingested: number;
  queued: number;
  skipped: number;
  redacted: number;
}

export interface UpdateInfo {
  ok?: boolean;
  update?: boolean;
  current?: string;
  latest?: string;
  message?: string;
  release_notes?: string;
  notice?: string;
  history?: Array<{ version: string; title: string; body: string; notice: string }>;
  html_url?: string;
  can_hot_update?: boolean;
  flavor?: string;
  source?: string;
  error?: string;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  skipped: boolean;
  error?: string;
}

export interface AgentRow {
  id: string;
  name: string;
  kind: string;
  builtin: boolean;
  enabled: boolean;
  rootPath: string;
  pathExists: boolean;
  lastScannedAt: string | null;
  lastScannedFiles: number;
  lastIngested: number;
  lastQueued: number;
  lastRedacted: number;
  lastError: string;
}

export interface KeyRow {
  id: string;
  name: string;
  tokenPrefix: string;
  tools: string;
  createdAt: string;
  recoverable: boolean;
}
