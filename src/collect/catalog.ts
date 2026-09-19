import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind, AgentRecord, AppConfig } from "../types.js";
import { claudeHome, cursorAgentStoresDir, toolHome } from "../paths.js";
import { nowIso } from "../util.js";

export interface AgentBlueprint {
  id: string;
  name: string;
  kind: AgentKind;
  rootPath: string;
  enabled: boolean;
}

export function builtinBlueprints(config: AppConfig): AgentBlueprint[] {
  const extra = config.collect.extraRoots.find((item) => item.trim()) || process.cwd();
  return [
    {
      id: "cursor",
      name: "Cursor",
      kind: "cursor",
      rootPath: cursorAgentStoresDir(),
      enabled: config.collect.cursor,
    },
    {
      id: "claude",
      name: "Claude Code",
      kind: "claude",
      rootPath: join(claudeHome(), "projects"),
      enabled: config.collect.claude,
    },
    {
      id: "codex",
      name: "Codex",
      kind: "codex",
      rootPath: toolHome(".codex", "CODEX_HOME"),
      enabled: config.collect.codex,
    },
    {
      id: "continue",
      name: "Continue",
      kind: "continue",
      rootPath: toolHome(".continue", "CONTINUE_HOME"),
      enabled: config.collect.continue,
    },
    {
      id: "projects",
      name: "项目约定文件",
      kind: "project",
      rootPath: extra,
      enabled: config.collect.projects,
    },
  ];
}

export function toAgentRecord(blueprint: AgentBlueprint): AgentRecord {
  return {
    id: blueprint.id,
    name: blueprint.name,
    kind: blueprint.kind,
    builtin: true,
    enabled: blueprint.enabled,
    rootPath: blueprint.rootPath,
    lastScannedAt: null,
    lastScannedFiles: 0,
    lastIngested: 0,
    lastQueued: 0,
    lastRedacted: 0,
    lastError: "",
    createdAt: nowIso(),
  };
}

export function pathExists(rootPath: string): boolean {
  return Boolean(rootPath.trim()) && existsSync(rootPath);
}
