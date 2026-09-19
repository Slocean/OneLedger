import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir(): string {
  return process.env.ONELEDGER_HOME?.trim() || join(homedir(), ".oneledger");
}

export function configPath(): string {
  return join(homeDir(), "config.json");
}

export function defaultSqlitePath(): string {
  return join(homeDir(), "data", "oneledger.db");
}

export function claudeHome(): string {
  return process.env.CLAUDE_HOME?.trim() || join(homedir(), ".claude");
}

export function cursorAgentStoresDir(): string {
  if (process.env.CURSOR_AGENT_STORES?.trim()) {
    return process.env.CURSOR_AGENT_STORES;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "Cursor", "AgentStores", "cursor_agent_stores");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "AgentStores", "cursor_agent_stores");
  }
  return join(homedir(), ".config", "Cursor", "AgentStores", "cursor_agent_stores");
}

export function toolHome(name: string, envName: string): string {
  return process.env[envName]?.trim() || join(homedir(), name);
}
