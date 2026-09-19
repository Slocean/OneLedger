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
      counts: { active: number; inbox: number; forgotten: number };
    }>("/api/status"),
  config: () => request<Record<string, unknown>>("/api/config"),
  saveConfig: (body: unknown) => request<{ ok: boolean }>("/api/config", { method: "PUT", body: JSON.stringify(body) }),
  memories: () => request<{ memories: Memory[] }>("/api/memories"),
  remember: (body: string, title?: string, promote = false) =>
    request<{ inboxId: string; memoryId?: string; redacted: boolean; queued: boolean }>("/api/remember", {
      method: "POST",
      body: JSON.stringify({ body, title, promote }),
    }),
  promote: (id: string, supersedeIds: string[] = []) =>
    request<{ memory: Memory }>(`/api/inbox/${id}/promote`, {
      method: "POST",
      body: JSON.stringify({ supersedeIds }),
    }),
  reject: (id: string) => request<{ ok: boolean }>(`/api/inbox/${id}/reject`, { method: "POST" }),
  updates: () => request<{ current: string; latest?: string; update?: boolean }>("/api/updates"),
  inbox: () => request<{ inbox: Inbox[] }>("/api/inbox"),
  audit: () => request<{ audit: Audit[]; redactions: Redaction[] }>("/api/audit"),
  collect: () => request<{ results: Collect[] }>("/api/collect", { method: "POST" }),
  sync: () => request<SyncReport>("/api/sync", { method: "POST" }),
  keys: () => request<{ keys: KeyRow[] }>("/api/keys"),
  createKey: (name: string) =>
    request<{ token: string; name: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name }) }),
};

export interface Memory {
  id: string;
  title: string;
  body: string;
  scopeKind: string;
  source: string;
  updatedAt: string;
  sensitivity: string;
}

export interface Inbox {
  id: string;
  title: string;
  body: string;
  source: string;
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

export interface SyncReport {
  pulled: number;
  pushed: number;
  skipped: boolean;
  error?: string;
}

export interface KeyRow {
  id: string;
  name: string;
  tokenPrefix: string;
  tools: string;
  createdAt: string;
}
