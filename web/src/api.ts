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
  memories: () => request<{ memories: Memory[] }>("/api/memories"),
  exportMemories: () =>
    request<{ name: string; version: string; exportedAt: string; count: number; memories: Memory[] }>(
      "/api/memories/export",
    ),
  remember: (body: string, opts?: { title?: string; scopeKind?: string; scopeId?: string }) =>
    request<{ inboxId: string; memoryId?: string; redacted: boolean; queued: boolean }>("/api/remember", {
      method: "POST",
      body: JSON.stringify({
        body,
        title: opts?.title,
        scopeKind: opts?.scopeKind,
        scopeId: opts?.scopeId,
      }),
    }),
  queueCustom: (body: string, title?: string) =>
    request<{ inboxId: string; queued: boolean }>("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ body, title }),
    }),
  reject: (id: string) => request<{ ok: boolean }>(`/api/inbox/${id}/reject`, { method: "POST" }),
  updates: () => request<UpdateInfo>("/api/updates"),
  downloadUpdate: () => request<{ ok: boolean; message?: string; error?: string; html_url?: string }>("/api/updates/download", { method: "POST" }),
  applyUpdate: () => request<{ ok: boolean; message?: string; error?: string }>("/api/updates/apply", { method: "POST" }),
  inbox: () => request<{ inbox: Inbox[] }>("/api/inbox"),
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
    request<{ token: string; name: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name }) }),
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
  createdAt: string;
  queueStatus: string;
  conflictIds: string[];
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
}
