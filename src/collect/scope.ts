import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".sync",
  "dist",
  "build",
  ".next",
  "coverage",
  "extensions",
  "site-packages",
  "vendor_imports",
  "modify_backup",
  ".venv",
  "venv",
  "virtualenv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
  "plugin-cache",
  "plugin_cache",
  "cacheddata",
  "cached_extensions",
  "blender",
  "blender_assets",
]);

const EXACT_PROJECT_FILES = new Set([
  "agents.md",
  "claude.md",
  "claude.local.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "gemini.md",
]);

const gitRootCache = new Map<string, string | undefined>();

export function isSkipDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

export function isProjectMemoryFile(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (EXACT_PROJECT_FILES.has(name)) return true;
  const parent = basename(dirname(filePath)).toLowerCase();
  const grand = basename(dirname(dirname(filePath))).toLowerCase();
  return (name.endsWith(".md") || name.endsWith(".mdc")) && parent === "rules" && grand === ".cursor";
}

export function isToolMemoryFile(filePath: string): boolean {
  if (isProjectMemoryFile(filePath)) return true;
  const name = basename(filePath).toLowerCase();
  if (name === "pages.json" || name === "license.txt" || name === "license.md") return false;
  const parts = splitPathParts(filePath).map((part) => part.toLowerCase());
  const mdOrTxt = name.endsWith(".md") || name.endsWith(".txt");
  if (!mdOrTxt) return false;
  if (name === "memory.md" || name === "memory.txt") return true;
  if (parts.includes("memory")) return true;
  if (name.includes("summary")) return true;
  if (parts.includes("summaries") || parts.includes("session_summaries")) return true;
  if (parts.includes("sessions")) return true;
  return false;
}

export function resolveProjectScopeId(filePath: string, collectRoot: string): string {
  const abs = resolve(filePath);
  const root = resolve(collectRoot);
  const gitRoot = findGitRoot(dirname(abs), root);
  if (gitRoot) return basename(gitRoot);

  const fromWorkspaceFile = workspaceFolderName(abs);
  if (fromWorkspaceFile) return fromWorkspaceFile;

  const fromEncoded = encodedProjectName(abs);
  if (fromEncoded) return fromEncoded;

  const fromWorkspaceDir = workspaceChildName(abs);
  if (fromWorkspaceDir) return fromWorkspaceDir;

  const fromKnownParent = knownProjectsChild(abs);
  if (fromKnownParent) return fromKnownParent;

  const rel = relative(root, abs);
  if (rel && !rel.startsWith("..") && rel !== abs) {
    const first = rel.split(/[\\/]/).find((part) => part && !part.startsWith(".") && !looksLikeFile(part) && !isSkipDirName(part));
    if (first) return first;
  }
  return basename(root);
}

export function findGitRoot(startDir: string, stopAt = ""): string | undefined {
  const start = resolve(startDir);
  const cacheKey = `${start}|${stopAt}`;
  const cached = gitRootCache.get(cacheKey);
  if (cached !== undefined || gitRootCache.has(cacheKey)) return cached;
  if (!existsSync(start)) {
    gitRootCache.set(cacheKey, undefined);
    return undefined;
  }
  const limit = stopAt ? resolve(stopAt) : "";
  let dir = start;
  for (let i = 0; i < 32; i++) {
    if (limit) {
      const rel = relative(limit, dir);
      if (rel.startsWith("..") && rel !== "") break;
    }
    if (existsSync(join(dir, ".git"))) {
      gitRootCache.set(cacheKey, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  gitRootCache.set(cacheKey, undefined);
  return undefined;
}

function workspaceFolderName(filePath: string): string | undefined {
  let dir = dirname(filePath);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "workspace.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { folder?: string; workspace?: string };
        const raw = parsed.folder || parsed.workspace || "";
        const cleaned = raw.replace(/^file:\/\//i, "").replace(/^\/([a-zA-Z]:)/, "$1");
        if (cleaned) return basename(cleaned.replace(/\//g, sep));
      } catch {
        // ignore malformed workspace records
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function encodedProjectName(filePath: string): string | undefined {
  for (const part of splitPathParts(filePath)) {
    const match = part.match(/^[a-z][-_]PROJECT[-_](.+)$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function workspaceChildName(filePath: string): string | undefined {
  const parts = splitPathParts(filePath);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() !== "workspace") continue;
    const next = parts[i + 1];
    if (!next || isSkipDirName(next)) continue;
    const lower = next.toLowerCase();
    if (lower === "sessions" || lower === "session" || lower === "backup" || lower === "backups") continue;
    if (looksLikeFile(next)) continue;
    return next;
  }
  return undefined;
}

function knownProjectsChild(filePath: string): string | undefined {
  const parts = splitPathParts(filePath);
  const markers = new Set(["project", "projects", "repos", "repo"]);
  for (let i = 0; i < parts.length - 1; i++) {
    if (!markers.has(parts[i].toLowerCase())) continue;
    const next = parts[i + 1];
    if (!next || isSkipDirName(next) || looksLikeFile(next) || next.startsWith(".")) continue;
    return next;
  }
  return undefined;
}

function looksLikeFile(name: string): boolean {
  return /\.[a-z0-9]{1,8}$/i.test(name);
}

function splitPathParts(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter(Boolean);
}

export function isOversized(filePath: string, maxBytes = 256_000): boolean {
  try {
    return statSync(filePath).size > maxBytes;
  } catch {
    return true;
  }
}
