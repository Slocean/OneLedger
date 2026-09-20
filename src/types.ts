export const APP_VERSION = "0.4.2";
export const CONFIG_SCHEMA_VERSION = 1;
export const DATA_SCHEMA_VERSION = 3;
export const PROTOCOL_VERSION = 1;

export type StorageDriver = "sqlite" | "postgres";
export type SyncRole = "local" | "leaf" | "hub";
export type DistillProvider = "none" | "openai-compatible";
export type Sensitivity = "public" | "internal" | "pii" | "secret";
export type MemoryStatus = "inbox" | "proposed" | "active" | "forgotten";
export type QueueStatus = "proposed" | "rejected";
export type MemoryScopeKind = "global" | "project" | "personal";
export type AgentKind = "cursor" | "claude" | "codex" | "continue" | "zcode" | "workbuddy" | "qoder" | "project" | "custom";

export interface AgentRecord {
  id: string;
  name: string;
  kind: AgentKind;
  builtin: boolean;
  enabled: boolean;
  rootPath: string;
  lastScannedAt: string | null;
  lastScannedFiles: number;
  lastIngested: number;
  lastQueued: number;
  lastRedacted: number;
  lastError: string;
  createdAt: string;
}

export interface AppConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  bind: string;
  port: number;
  storage: {
    driver: StorageDriver;
    sqlitePath: string;
    postgresUrl: string;
  };
  sync: {
    role: SyncRole;
    remoteUrl: string;
    nodeKey: string;
    intervalMin: number;
  };
  collect: {
    cursor: boolean;
    claude: boolean;
    codex: boolean;
    continue: boolean;
    zcode: boolean;
    workbuddy: boolean;
    qoder: boolean;
    projects: boolean;
    intervalMin: number;
    extraRoots: string[];
  };
  distill: {
    provider: DistillProvider;
    baseUrl: string;
    model: string;
    apiKey: string;
  };
  security: {
    scanEnabled: boolean;
    allowInternalInSearch: boolean;
  };
  updateUrl: string;
  adminToken: string;
}

export interface MemoryRecord {
  id: string;
  rev: number;
  title: string;
  body: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  sensitivity: Sensitivity;
  status: MemoryStatus;
  source: string;
  originNode: string;
  contentHash: string;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  forgottenAt: string | null;
}

export interface InboxRecord {
  id: string;
  title: string;
  body: string;
  source: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  sensitivity: Sensitivity;
  redacted: number;
  queueStatus: QueueStatus;
  conflictIds: string[];
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: string;
  tools: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ScanHit {
  type: string;
  level: Sensitivity;
}

export interface ScanResult {
  cleanText: string;
  hits: ScanHit[];
  highest: Sensitivity;
}

export interface CollectResult {
  source: string;
  scannedFiles: number;
  ingested: number;
  queued: number;
  skipped: number;
  redacted: number;
}
