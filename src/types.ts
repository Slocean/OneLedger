export const APP_VERSION = "0.1.0";
export const CONFIG_SCHEMA_VERSION = 1;
export const DATA_SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 1;

export type StorageDriver = "sqlite" | "postgres";
export type SyncRole = "local" | "leaf" | "hub";
export type DistillProvider = "none" | "openai-compatible";
export type Sensitivity = "public" | "internal" | "pii" | "secret";
export type MemoryStatus = "inbox" | "proposed" | "active" | "forgotten";
export type MemoryScopeKind = "global" | "project" | "personal";

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
  skipped: number;
  redacted: number;
}
