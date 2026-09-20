import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "./types.js";

export const GITHUB_OWNER = "Slocean";
export const GITHUB_REPO = "OneLedger";
export const DEFAULT_UPDATE_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/app_update.json`;
export const CHANNEL_MIRRORS = [
  `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@main/app_update.json`,
  `https://raw.gitmirror.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/app_update.json`,
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/raw/main/app_update.json`,
  DEFAULT_UPDATE_URL,
];
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
export const PORTABLE_ASSET = "OneLedger-Portable.exe";
export const SETUP_ASSET = "OneLedger-Setup.exe";

const VERSION_RE = /^v?(\d+(?:\.\d+)*)/i;
const USER_AGENT = `OneLedger/${APP_VERSION} (+https://github.com/${GITHUB_OWNER}/${GITHUB_REPO})`;

export interface ChannelEntry {
  version: string;
  title: string;
  body: string;
  notice: string;
}

export function parseVersion(text: string): number[] {
  const match = VERSION_RE.exec(String(text || "").trim());
  if (!match) return [0];
  return match[1].split(".").map((part) => Number(part));
}

export function versionGt(remote: string, local: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

export function normalizeChannel(raw: unknown): { history: ChannelEntry[] } {
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { history?: unknown }).history)
      ? (raw as { history: unknown[] }).history
      : raw && typeof raw === "object"
        ? [raw]
        : [];
  const history: ChannelEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const version = String(row.version ?? "").replace(/^v/i, "").trim();
    const title = String(row.title ?? "").trim();
    const body = String(row.body ?? "").trim();
    const notice = String(row.notice ?? "").trim();
    if (!version && !title && !body && !notice) continue;
    history.push({
      version,
      title: title || (version ? `${version} 更新` : "更新公告"),
      body,
      notice,
    });
  }
  return { history };
}

export function loadLocalChannel(root = process.cwd()): { history: ChannelEntry[] } | undefined {
  const path = join(root, "app_update.json");
  if (!existsSync(path)) return undefined;
  try {
    return normalizeChannel(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function effectiveNotice(history: ChannelEntry[]): string {
  return history.find((item) => item.notice)?.notice ?? "";
}

async function httpJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/json,text/plain,*/*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchChannel(updateUrl: string): Promise<{
  ok: boolean;
  source: string;
  channel: { history: ChannelEntry[] };
  error?: string;
}> {
  const urls: string[] = [];
  if (updateUrl.trim()) urls.push(updateUrl.trim());
  for (const mirror of CHANNEL_MIRRORS) {
    if (!urls.includes(mirror)) urls.push(mirror);
  }
  let lastError = "检查更新失败";
  for (const url of urls) {
    try {
      const channel = normalizeChannel(await httpJson(url));
      if (channel.history.length > 0) return { ok: true, source: url, channel };
      lastError = `${url} 通道为空`;
    } catch (error) {
      lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const local = loadLocalChannel();
  if (local?.history.length) return { ok: true, source: "local", channel: local };
  return { ok: false, source: "none", channel: { history: [] }, error: lastError };
}

function releaseDownloadUrl(tag: string, asset: string) {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${asset}`;
}

async function resolveDownload(
  version: string,
  asset: string,
): Promise<{
  ok: boolean;
  pending?: boolean;
  download_url?: string;
  checksum_url?: string;
  html_url?: string;
  error?: string;
}> {
  const tag = `v${version.replace(/^v/i, "")}`;
  const html = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${tag}`;
  const fallback = {
    ok: true as const,
    download_url: releaseDownloadUrl(tag, asset),
    checksum_url: releaseDownloadUrl(tag, `${asset}.sha256`),
    html_url: html,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/vnd.github+json",
      },
    });
    clearTimeout(timer);
    if (response.status === 404) {
      return { ok: false, pending: true, html_url: html, error: `${tag} 尚未发布或还在打包` };
    }
    if (!response.ok) return fallback;
    const data = (await response.json()) as { assets?: Array<{ name?: string; browser_download_url?: string }>; html_url?: string };
    const assets = data.assets ?? [];
    const exe = assets.find((item) => item.name === asset);
    const sum = assets.find((item) => item.name === `${asset}.sha256`);
    if (!exe?.browser_download_url || !sum?.browser_download_url) return fallback;
    return {
      ok: true,
      download_url: exe.browser_download_url,
      checksum_url: sum.browser_download_url,
      html_url: data.html_url ?? html,
    };
  } catch {
    return fallback;
  }
}

export async function checkForUpdate(updateUrl: string) {
  const local = APP_VERSION;
  const ch = await fetchChannel(updateUrl);
  if (!ch.ok) {
    return { ok: false, current: local, current_version: local, error: ch.error || "检查更新失败" };
  }
  const history = ch.channel.history;
  const latest = history[0]?.version || local;
  const notes = history[0]?.body || "";
  const notice = effectiveNotice(history);
  const portable = latest ? await resolveDownload(latest, PORTABLE_ASSET) : { ok: false as const };
  const setup = latest ? await resolveDownload(latest, SETUP_ASSET) : { ok: false as const };
  const available = versionGt(latest, local);
  const assetReady = Boolean(portable.ok && setup.ok);
  return {
    ok: true,
    update: available,
    update_available: available,
    current: local,
    current_version: local,
    latest,
    latest_version: latest,
    release_notes: notes,
    notice,
    history,
    flavor: "service",
    asset_name: "",
    html_url: portable.html_url || setup.html_url || RELEASES_PAGE_URL,
    download_url: null,
    checksum_url: null,
    portable_ready: Boolean(portable.ok),
    setup_ready: Boolean(setup.ok),
    asset_ready: assetReady,
    asset_pending: Boolean(portable.pending || setup.pending),
    asset_error: portable.ok && setup.ok ? null : portable.error || setup.error || null,
    can_hot_update: false,
    source: ch.source,
    message: available
      ? assetReady
        ? `发现新版本 ${latest}（服务模式请到 Releases 下载对应安装包或便携包）`
        : `发现新版本 ${latest}，安装包尚未就绪`
      : "已是最新版本",
  };
}
