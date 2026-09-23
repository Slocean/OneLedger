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
  resolveInbox: (ids: string[], body: string, title: string, expectedRev: number) =>
    request<{ status: string; currentRev?: number; hits?: Array<{ type: string; field?: string; line?: number }> }>("/api/inbox/resolve", {
      method: "POST",
      body: JSON.stringify({ ids, body, title, expectedRev }),
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
  inbox: (status: "proposed" | "rejected" = "proposed", offset = 0) => request<{ inbox: Inbox[]; hasMore: boolean }>(`/api/inbox?status=${status}&offset=${offset}`),
  pruneHistory: () => request<{ ok: boolean; archivedEvents: number; removedRejected: number }>("/api/history/prune", { method: "POST" }),
  distillTasks: () => request<{ tasks: DistillTask[]; provider: string; model: string }>("/api/distill/tasks"),
  distillDraft: (scopeKind: string, scopeId: string) =>
    request<{ status: string; draft?: DistillDraft; error?: string; blocked?: string[]; attempts?: number }>("/api/distill/draft", {
      method: "POST",
      body: JSON.stringify({ scopeKind, scopeId }),
    }),
  discardDraft: (id: string) => request<{ ok: boolean }>(`/api/distill/draft/${id}/discard`, { method: "POST" }),
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
  hits?: string[];
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
  highSignal: number;
  sources: Array<{ id: string; title: string; source: string; sensitivity: string; createdAt: string; redacted: boolean }>;
  draft?: DistillDraft;
  lastResult?: { status: string; error: string; attempts: number; at: string };
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
}
