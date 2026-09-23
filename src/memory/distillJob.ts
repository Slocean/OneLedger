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
  status: "pending" | "stale" | "failed" | "discarded";
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

function sourceFingerprint(item: InboxRecord): string {
  return `${item.id}:${sha256(`${item.title}\n${item.body}`)}`;
}

export class DistillJobService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  /** 采集完成后按作用域聚合待蒸馏材料，附上待审草稿与最近一次处理结果。 */
  async tasks(): Promise<DistillTask[]> {
    const summary = await this.store.inboxScopeSummary();
    const samples = new Map<string, InboxRecord[]>();
    for (const item of await this.store.inboxSamplesByScope(40)) {
      const key = `${item.scopeKind}\u0000${item.scopeId}`;
      const list = samples.get(key) ?? [];
      list.push(item);
      samples.set(key, list);
    }
    const drafts = await this.store.allLatestDrafts();
    return summary.map(({ scopeKind, scopeId, pending, highSignal, oldestAt }) => {
      const key = `${scopeKind}\u0000${scopeId}`;
      const draft = drafts.get(key);
      return {
        scopeKind,
        scopeId,
        pending,
        oldestWaitingAt: oldestAt,
        highSignal,
        sources: (samples.get(key) ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          source: item.source,
          sensitivity: item.sensitivity,
          createdAt: item.createdAt,
          redacted: item.redacted === 1,
        })),
        draft,
        lastResult: draft
          ? { status: draft.status, error: draft.error, attempts: draft.attempts, at: draft.updatedAt }
          : undefined,
      };
    });
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

  /** 管理员侧生成草稿：按作用域分批读取安全材料，记录来源与 expectedRev。绝不自动晋升。 */
  async generateDraft(scopeKind: string, scopeId: string, actor: string): Promise<Record<string, unknown>> {
    if (!this.config.distill.provider || this.config.distill.provider === "none") {
      return { status: "error", error: "distill.provider=none：请手工整理正文，或先配置模型提供方。" };
    }
    const pending = await this.store.inboxScopeSample(scopeKind, scopeId, 200);
    if (!pending.length) return { status: "error", error: "该作用域没有待蒸馏材料" };
    const { safe, blocked } = this.safeSources(pending);
    if (!safe.length) return { status: "error", error: "材料全部未通过安全扫描，未发送给模型", blocked };
    const used = safe.slice(0, MAX_SOURCES);
    const existing = await this.store.listActiveByScope(scopeKind as InboxRecord["scopeKind"], scopeId);
    const expectedRev = existing[0]?.rev ?? 0;
    const scopeLabel = scopeId ? `${scopeKind}/${scopeId}` : scopeKind;
    const { system, user } = this.buildPrompt(scopeLabel, existing[0]?.title ?? "", used);

    const previous = await this.store.latestDraft(scopeKind, scopeId);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      return { status: "error", error: `同一作用域已连续失败 ${MAX_ATTEMPTS} 次，请检查配置后手动重试。` };
    }
    const fingerprintById = new Map(pending.map((item) => [item.id, sourceFingerprint(item)]));
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
