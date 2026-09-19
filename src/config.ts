import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_SCHEMA_VERSION, type AppConfig } from "./types.js";
import { configPath, defaultSqlitePath, homeDir } from "./paths.js";

export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function defaultConfig(): AppConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    bind: "127.0.0.1",
    port: 7443,
    storage: {
      driver: "sqlite",
      sqlitePath: defaultSqlitePath(),
      postgresUrl: "",
    },
    sync: {
      role: "local",
      remoteUrl: "",
      nodeKey: randomSecret(18),
      intervalMin: 15,
    },
    collect: {
      cursor: true,
      claude: true,
      projects: true,
      intervalMin: 30,
      extraRoots: [],
      codex: true,
      continue: true,
      zcode: true,
      workbuddy: true,
      qoder: true,
    },
    distill: {
      provider: "none",
      baseUrl: "",
      model: "",
      apiKey: "",
    },
    security: {
      scanEnabled: true,
      allowInternalInSearch: true,
    },
    updateUrl: "",
    adminToken: randomSecret(24),
  };
}

function mergeConfig(raw: Partial<AppConfig>): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    ...raw,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    storage: { ...base.storage, ...raw.storage },
    sync: { ...base.sync, ...raw.sync },
    collect: { ...base.collect, ...raw.collect },
    distill: { ...base.distill, ...raw.distill },
    security: { ...base.security, ...raw.security },
    adminToken: raw.adminToken || base.adminToken,
  };
}

export function loadConfig(): AppConfig {
  const path = configPath();
  if (!existsSync(path)) {
    const created = defaultConfig();
    saveConfig(created);
    return created;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  const merged = mergeConfig(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(merged)) {
    saveConfig(merged);
  }
  return merged;
}

export function saveConfig(config: AppConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function publicConfig(config: AppConfig) {
  return {
    ...config,
    adminToken: config.adminToken ? "•••• set" : "",
    storage: {
      ...config.storage,
      postgresUrl: maskUrl(config.storage.postgresUrl),
    },
    sync: {
      ...config.sync,
      nodeKey: config.sync.nodeKey ? "•••• set" : "",
    },
    distill: {
      ...config.distill,
      apiKey: config.distill.apiKey ? "•••• set" : "",
    },
  };
}

function maskUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return "(set)";
  }
}
