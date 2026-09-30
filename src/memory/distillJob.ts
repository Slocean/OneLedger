import { randomUUID } from "node:crypto";
import type { AppConfig, InboxRecord } from "../types.js";
import { scanAndRedact, verifyRedacted } from "../security/scan.js";
import { nowIso, sha256 } from "../util.js";
import type { Store } from "./store.js";

/** 每个作用域最多送给模型的安全材料条数，限制输入长度。 */
const MAX_SOURCES = 12;
const MAX_SOURCE_CHARS = 4000;
const MAX_TOTAL_CHARS = 24_000;
/** 同一草稿的自动重试上限，超过后只能由管理员重新发起。 */
export const MAX_ATTEMPTS = 3;

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
  status: "pending" | "stale" | "failed" | "discarded" | "applied";
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
  /** WorkBuddy 来源的材料条数（如实计数，不再称作“高信号”）。 */
  workbuddy: number;
  abnormal: boolean;
  draft?: DistillDraft;
  lastResult?: { status: string; error: string; attempts: number; at: string };
}

function sourceFingerprint(item: InboxRecord): string {
  return `${item.id}:${sha256(`${item.title}\n${item.body}`)}`;
}

export class DistillJobService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  /** 采集完成后按作用域聚合待蒸馏材料，附上待审草稿与最近一次处理结果。
   *  服务端分页：本页作用域的摘要与最新草稿各一次查询，样本与明细由 /api/inbox 按需加载。 */
  async tasksPage(query: string, onlyAbnormal: boolean, limit: number, offset: number): Promise<{ tasks: DistillTask[]; total: number }> {
    const { rows, total } = await this.store.inboxScopePage(query, onlyAbnormal, limit, offset);
    const drafts = await this.store.latestDraftsForScopes(rows.map((row) => ({ scopeKind: row.scopeKind, scopeId: row.scopeId })));
    const tasks = rows.map((row) => {
      const draft = drafts.get(`${row.scopeKind}\u0000${row.scopeId}`);
      return {
        scopeKind: row.scopeKind,
        scopeId: row.scopeId,
        pending: row.pending,
        oldestWaitingAt: row.oldestAt,
        workbuddy: row.workbuddy,
        abnormal: row.scopeKind === "project" && this.store.scopeIdLooksLikePath(row.scopeId),
        draft,
        lastResult: draft
          ? { status: draft.status, error: draft.error, attempts: draft.attempts, at: draft.updatedAt }
          : undefined,
      };
    });
    return { tasks, total };
  }

  /** 只把通过安全扫描的材料交给模型；任何残留 secret 直接排除并记录。
   *  二次验证：替换后的文本仍命中规则时同样排除。 */
  private safeSources(items: InboxRecord[]): { safe: Array<{ id: string; source: string; body: string }>; blocked: string[] } {
    const safe: Array<{ id: string; source: string; body: string }> = [];
    const blocked: string[] = [];
    for (const item of items) {
      if (item.sensitivity === "secret" || item.queueStatus === "rejected") {
        blocked.push(item.id);
        continue;
      }
      const scanned = scanAndRedact(`${item.title}\n${item.body}`);
      if (scanned.highest === "secret" || verifyRedacted(scanned.cleanText).length > 0) {
        blocked.push(item.id);
        continue;
      }
      safe.push({ id: item.id, source: item.source, body: scanned.cleanText });
    }
    return { safe, blocked };
  }

  private buildPrompt(scopeLabel: string, title: string, sources: Array<{ source: string; body: string }>): { system: string; user: string } {
    const system =
      "你是 OneLedger 的记忆蒸馏助手。输入是某个作用域下已脱敏的采集材料，请输出一份整篇记忆。" +
      "要求：整篇覆盖、不要追加原文、不要逐条罗列、不要编造输入中没有的事实；保留关键决策、约定、路径与流程；" +
      "只输出记忆正文，第一行作为标题（不超过 60 字），随后空一行再写正文。" +
      `\n当前作用域：${scopeLabel}；已有标题：${title}`;
    let user = "";
    for (const [index, source] of sources.entries()) {
      const clipped = [...source.body].slice(0, MAX_SOURCE_CHARS).join("");
      const next = `【材料 ${index + 1}｜来源 ${source.source}】\n${clipped}\n\n`;
      if ([...user].length + [...next].length > MAX_TOTAL_CHARS) break;
      user += next;
    }
    return { system, user };
  }

  private async callProvider(system: string, user: string): Promise<string> {
    const base = this.config.distill.baseUrl.trim().replace(/\/+$/, "");
    if (!base) throw new Error("未配置模型 baseUrl");
    if (!this.config.distill.model.trim()) throw new Error("未配置模型名称");
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.distill.apiKey.trim() ? { authorization: `Bearer ${this.config.distill.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.distill.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`模型返回 ${response.status}`);
    const value = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = value.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("模型未返回正文");
    return content;
  }

  private splitTitleBody(text: string): { title: string; body: string } {
    const lines = text.split(/\r?\n/);
    const first = (lines.shift() ?? "").trim().replace(/^#+\s*/, "");
    const rest = lines.join("\n").trim();
    if (!rest) return { title: text.trim().slice(0, 60), body: text.trim() };
    const title = first || rest.split(/\r?\n/)[0]!.trim().slice(0, 60);
    return { title: title.slice(0, 60), body: rest };
  }

  /** 管理员侧生成草稿：只接收管理员显式选中的来源 ID，逐条复核作用域与状态。
   *  绝不自动晋升。 */
  async generateDraft(scopeKind: string, scopeId: string, sourceIds: string[], actor: string): Promise<Record<string, unknown>> {
    if (!this.config.distill.provider || this.config.distill.provider === "none") {
      return { status: "error", error: "distill.provider=none：请手工整理正文，或先配置模型提供方。" };
    }
    if (!sourceIds.length) return { status: "error", error: "请先勾选本次要蒸馏的材料" };
    if (sourceIds.length > MAX_SOURCES) return { status: "error", error: `一次最多选择 ${MAX_SOURCES} 条材料` };
    const unique = [...new Set(sourceIds)];
    if (unique.length !== sourceIds.length) return { status: "error", error: "来源材料重复选择" };
    const scoped: InboxRecord[] = [];
    for (const id of sourceIds) {
      const item = await this.store.getInbox(id);
      if (!item || item.queueStatus !== "proposed" || item.scopeKind !== scopeKind || item.scopeId !== scopeId) {
        return { status: "error", error: "材料不存在、已被处理或不属于该作用域", inboxId: id };
      }
      scoped.push(item);
    }
    const { safe, blocked } = this.safeSources(scoped);
    if (!safe.length) return { status: "error", error: "所选材料全部未通过安全扫描，未发送给模型", blocked };
    const safeIds = new Set(safe.map((item) => item.id));
    const used = scoped.filter((item) => safeIds.has(item.id));
    const existing = await this.store.listActiveByScope(scopeKind as InboxRecord["scopeKind"], scopeId);
    const expectedRev = existing[0]?.rev ?? 0;
    const scopeLabel = scopeId ? `${scopeKind}/${scopeId}` : scopeKind;
    const { system, user } = this.buildPrompt(scopeLabel, existing[0]?.title ?? "", safe.map(({ source, body }) => ({ source, body })));

    const previous = await this.store.latestDraft(scopeKind, scopeId);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      return { status: "error", error: `同一作用域已连续失败 ${MAX_ATTEMPTS} 次，请检查配置后手动重试。` };
    }
    const fingerprintById = new Map(scoped.map((item) => [item.id, sourceFingerprint(item)]));
    const base: DistillDraft = {
      id: previous?.id ?? `dd_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      scopeKind,
      scopeId,
      title: previous?.title ?? "",
      body: previous?.body ?? "",
      sourceIds: used.map((item) => item.id),
      sourceFingerprints: used.map((item) => fingerprintById.get(item.id) ?? ""),
      expectedRev,
      provider: this.config.distill.provider,
      model: this.config.distill.model,
      status: "pending",
      staleReason: "",
      error: "",
      attempts,
      createdAt: previous?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };

    let content: string;
    try {
      content = await this.callProvider(system, user);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.upsertDraft({ ...base, status: "failed", error: message });
      await this.store.audit(actor, "distill.failed", `${scopeLabel}: ${message}`);
      return { status: "failed", error: message, attempts, blocked };
    }
    const { title, body } = this.splitTitleBody(content);
    const draft: DistillDraft = { ...base, title, body };
    await this.store.upsertDraft(draft);
    await this.store.audit(actor, "distill.draft", `${scopeLabel} <- ${draft.sourceIds.length} 条材料`);
    return { status: "pending", draft, blocked };
  }

  /** 来源、rev 或扫描状态变化时把草稿标记为过期，要求重新审核。 */
  async markStaleIfChanged(draft: DistillDraft): Promise<string | undefined> {
    if (draft.status !== "pending") return undefined;
    const reasons: string[] = [];
    const current = await this.store.listActiveByScope(draft.scopeKind as InboxRecord["scopeKind"], draft.scopeId);
    const currentRev = current[0]?.rev ?? 0;
    if (currentRev !== draft.expectedRev) reasons.push(`作用域已更新到 rev ${currentRev}`);
    for (const [index, id] of draft.sourceIds.entries()) {
      const item = await this.store.getInbox(id);
      if (!item) {
        reasons.push("来源已被处理或删除");
      } else {
        const expected = draft.sourceFingerprints[index] ?? "";
        if (expected && sourceFingerprint(item) !== expected) reasons.push("来源内容已变化");
        if (item.queueStatus !== "proposed") reasons.push("来源状态已变化");
      }
      if (reasons.length >= 2) break;
    }
    const reason = reasons.join("；");
    if (!reason) return undefined;
    await this.store.upsertDraft({ ...draft, status: "stale", staleReason: reason, updatedAt: nowIso() });
    return reason;
  }

  async discardDraft(id: string, actor: string): Promise<boolean> {
    const draft = await this.store.getDraft(id);
    if (!draft) return false;
    await this.store.upsertDraft({ ...draft, status: "discarded", updatedAt: nowIso() });
    await this.store.audit(actor, "distill.discard", id);
    return true;
  }
}
