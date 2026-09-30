import type { CollectResult, InboxRecord, MemoryRecord, MemoryScopeKind, ScopeFilter, Sensitivity } from "../types.js";
import type { AppConfig } from "../types.js";
import { SCAN_RULES_VERSION } from "../types.js";
import { findConflicts, shouldAutoPromote } from "../distill/conflict.js";
import { scanAndRedact, verifyRedacted } from "../security/scan.js";
import type { DistillDraft } from "./distillJob.js";
import { clipTitle, hashToken, newId, nowIso, sha256 } from "../util.js";
import { Store } from "./store.js";

const SAFE_LEVELS = new Set<Sensitivity>(["public", "internal"]);

/// 二次验证：对替换后的正文与标题再次扫描。
/// 返回为空表示可以写入；命中非空表示替换不完整或无法证明完整，必须拒收。
function secondPassHits(body: string, title: string): Array<{ type: string; line?: number; field: string }> {
  return [
    ...verifyRedacted(body).map((hit) => ({ type: hit.type, line: hit.line, field: "body" })),
    ...verifyRedacted(title).map((hit) => ({ type: hit.type, line: hit.line, field: "title" })),
  ];
}

class RevisionConflict extends Error {
  constructor(readonly currentRev: number) { super("memory revision changed"); }
}

/** remember 事务内遇到业务 error 时抛出，让外层回滚并把原结果带回给调用方。 */
class RememberOutcomeError extends Error {
  constructor(readonly outcome: {
    inboxId: string;
    redacted: boolean;
    queued: boolean;
    conflicts: string[];
    status: "stored" | "queued" | "rejected" | "unchanged" | "conflict" | "error";
    memoryId?: string;
    rev?: number;
    currentRev?: number;
    hits?: Array<{ type: string; line?: number }>;
  }) {
    super("remember outcome error");
  }
}

export function isOfficialDistillSource(source: string): boolean {
  return source === "ui" || source.startsWith("ui:") || source.startsWith("mcp:");
}

/** 来源路径形态：保守区分五类，避免归一化把无法证明同一性的不同文件合并成同一个键。 */
export type SourcePathKind = "drive-absolute" | "drive-relative" | "unc" | "posix-absolute" | "relative";

interface ClassifiedSourcePath {
  kind: SourcePathKind;
  key: string;
}

function finishClassify(kind: SourcePathKind, rest: string, prefix = ""): ClassifiedSourcePath | null {
  const segments: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.pop()) return null; // .. 越过根，无法证明规范形式
      continue;
    }
    segments.push(part);
  }
  if (!segments.length) return null;
  return { kind, key: prefix + segments.join("/") };
}

function classifySourcePath(path: string, platform: string): ClassifiedSourcePath | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  // 反斜杠只是 Windows 的分隔符；POSIX 文件名可含字面反斜杠，必须保留身份不得折叠。
  const folded = platform === "win32" ? trimmed.replaceAll("\\", "/") : trimmed;
  if (folded.startsWith("/")) {
    const slashes = folded.length - folded.replace(/^\/+/, "").length;
    if (slashes >= 3) return null; // 多余前导斜杠语义依平台而定，无法保守证明身份
    // UNC 不折叠 // 前缀：保留身份，且永不与 POSIX 绝对路径合并
    if (slashes === 2) return finishClassify("unc", folded.slice(2), "//");
    return finishClassify("posix-absolute", folded.slice(1), "/");
  }
  if (platform === "win32") {
    if (/^[A-Za-z]:/.test(folded)) {
      const drive = `${folded[0]!.toLowerCase()}:`;
      const rest = folded.slice(2);
      if (rest.startsWith("/")) return finishClassify("drive-absolute", rest.slice(1), `${drive}/`);
      return finishClassify("drive-relative", rest, drive);
    }
  }
  return finishClassify("relative", folded);
}

/** 平台明确的 canonical source-key（C-06，第五轮修复）：统一分隔符、消解 . / .. 片段，
 *  并保守区分五种形态——盘符绝对 / 盘符相对 / UNC / POSIX 绝对 / 相对，各自身份互不吞并：
 *  - Windows：盘符绝对路径可证明全局唯一；POSIX 绝对路径（可能来自 WSL/挂载）保留身份
 *    但不证明唯一；UNC 不折叠 `//` 前缀；盘符相对（C:foo）与相对路径按作用域去重。
 *  - 非 Windows：POSIX 绝对路径（单根）保留根斜杠且可证明唯一；`//` 开头的 UNC 不折叠、
 *    不全局；`C:/...` 只是首段恰为 `C:` 的相对路径，不做盘符解释（大小写也不折叠）。
 *  除盘符外不做大小写折叠：保守方向是不吞文件（大小写不同按不同文件处理）。
 *  无法保守规范化（空、纯根、.. 越根、3 个以上前导斜杠）时返回 null，调用方退回原值。 */
export function canonicalSourceKey(path: string, platform: NodeJS.Platform = process.platform): string | null {
  return classifySourcePath(path, platform)?.key ?? null;
}

/** 可证明跨作用域唯一的来源键：Windows 上的盘符绝对路径、非 Windows 上的 POSIX 绝对路径。
 *  只有这类键才允许跨作用域判断“同一文件”；相对名/短名/UNC/盘符相对/WSL 风格路径继续按
 *  作用域去重，避免共享文件名（如两个仓库各自的 AGENTS.md）跨项目吞材料（P0-04/C-06）。 */
export function sourceKeyIsGlobal(sourceKey: string, platform: NodeJS.Platform = process.platform): boolean {
  const classified = classifySourcePath(sourceKey, platform);
  if (!classified) return false;
  return platform === "win32" ? classified.kind === "drive-absolute" : classified.kind === "posix-absolute";
}

function officialTitle(scopeKind: MemoryScopeKind, scopeId: string, text: string): string {
  if (scopeKind === "project" && scopeId) return `项目 ${scopeId}`;
  if (scopeKind === "personal") return "个人记忆";
  if (text.includes("\n") || text.length > 80) return "蒸馏记忆";
  return clipTitle(text, "蒸馏记忆");
}

export interface RememberInput {
  title?: string;
  body: string;
  source: string;
  scopeKind?: MemoryScopeKind;
  scopeId?: string;
  actor: string;
  promote?: boolean;
  expectedRev?: number;
  /** 稳定来源键；采集路径必填，UI/MCP 直写留空与人工/历史行同键互认（B-05）。 */
  sourceKey?: string;
}

export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  nodeId(): string {
    return this.config.sync.nodeKey.slice(0, 8) || "local";
  }

  async remember(input: RememberInput): Promise<{
    inboxId: string;
    memoryId?: string;
    redacted: boolean;
    queued: boolean;
    conflicts: string[];
    status: "stored" | "queued" | "rejected" | "unchanged" | "conflict" | "error";
    rev?: number;
    currentRev?: number;
    hits?: Array<{ type: string; line?: number }>;
  }> {
    // 外层事务：材料入队、脱敏事件与审计同生共死；error 结果回滚后原样返回。
    try {
      return await this.store.transaction(async (tx) => {
        const outcome = await this.rememberOn(tx, input);
        if (outcome.status === "error") throw new RememberOutcomeError(outcome);
        return outcome;
      });
    } catch (error) {
      if (error instanceof RememberOutcomeError) return error.outcome;
      throw error;
    }
  }

  /** remember 的事务感知实现：调用方可传入事务内的 store（如采集指纹同事务）。 */
  private async rememberOn(
    store: Store,
    input: RememberInput,
  ): Promise<{
    inboxId: string;
    memoryId?: string;
    redacted: boolean;
    queued: boolean;
    conflicts: string[];
    status: "stored" | "queued" | "rejected" | "unchanged" | "conflict" | "error";
    rev?: number;
    currentRev?: number;
    hits?: Array<{ type: string; line?: number }>;
  }> {
    const scanned = this.config.security.scanEnabled
      ? scanAndRedact(input.body)
      : { cleanText: input.body, hits: [], highest: "public" as const };
    const titleScan = this.config.security.scanEnabled
      ? scanAndRedact(input.title ?? "")
      : { cleanText: input.title ?? "", hits: [], highest: "public" as const };
    const allHits = [...scanned.hits.map((hit) => ({ ...hit, field: "body" })), ...titleScan.hits.map((hit) => ({ ...hit, field: "title" }))];
    const highest = scanned.highest === "secret" || titleScan.highest === "secret"
      ? "secret" : scanned.highest === "pii" || titleScan.highest === "pii" ? "pii" : scanned.highest;

    const unsafeRedaction = allHits.some((hit) => hit.type === "high_entropy" || hit.type === "private_key_incomplete");
    // 二次验证：替换后的标题与正文不得再命中任何规则。
    // 命中即说明替换不完整（或无法证明完整），必须拒收。
    const residue = secondPassHits(scanned.cleanText, titleScan.cleanText);
    const collectedScopeKind = input.scopeKind ?? "personal";
    const collectedScopeId = input.scopeId ?? "";
    const collectedSourceKey = input.sourceKey ?? "";
    if (!isOfficialDistillSource(input.source)) {
      const existingInbox = await store.findCollectedInbox(input.source, collectedScopeKind, collectedScopeId, scanned.cleanText.trim(), collectedSourceKey);
      if (existingInbox) {
        return { status: "unchanged", inboxId: existingInbox.id, redacted: existingInbox.redacted === 1, queued: existingInbox.queueStatus === "proposed", conflicts: [] };
      }
    }

    if ((highest === "secret" && unsafeRedaction) || residue.length > 0) {
      const inbox = await store.insertInbox({
        title: clipTitle(scanned.cleanText, "Redacted note"),
        body: scanned.cleanText.trim(),
        source: input.source,
        scopeKind: input.scopeKind ?? "personal",
        scopeId: input.scopeId ?? "",
        sensitivity: "secret",
        redacted: 1,
        queueStatus: "rejected",
        conflictIds: [],
        sourceKey: collectedSourceKey,
      });
      for (const hit of allHits) {
        await store.addRedaction(input.source, hit.type, inbox.id);
      }
      for (const hit of residue) {
        await store.addRedaction(input.source, hit.type, inbox.id);
      }
      await store.audit(input.actor, "remember.redacted", inbox.id);
      const reported = [
        ...allHits.map(({ type, line, field }) => ({ type, line, field })),
        ...residue.map(({ type, line, field }) => ({ type, line, field })),
      ];
      return { status: "rejected", inboxId: inbox.id, redacted: true, queued: false, conflicts: [], hits: reported };
    }

    const text = scanned.cleanText.trim();
    const scopeKind = input.scopeKind ?? "global";
    const scopeId = input.scopeId ?? "";
    const title = titleScan.cleanText.trim() || officialTitle(scopeKind, scopeId, text);
    const sensitivity: Sensitivity = allHits.length > 0 ? "public" : highest;
    const hash = sha256(`${title}\n${text}`);
    const currentRev = (await store.listActiveByScope(scopeKind, scopeId))[0]?.rev ?? 0;
    if ((input.expectedRev !== undefined && currentRev !== input.expectedRev) || (input.expectedRev === undefined && currentRev > 0 && isOfficialDistillSource(input.source))) {
      return { status: "conflict", inboxId: "", redacted: allHits.length > 0, queued: false, conflicts: [], currentRev };
    }
    const existing = await store.findActiveByHash(hash, scopeKind, scopeId);
    if (existing && existing.sensitivity === sensitivity) {
      await store.audit(input.actor, "remember.dedup", existing.id);
      return { status: "unchanged", inboxId: "", memoryId: existing.id, rev: existing.rev, redacted: allHits.length > 0, queued: false, conflicts: [], hits: allHits.map(({ type, line, field }) => ({ type, line, field })) };
    }

    const conflicts = findConflicts(text, title, await store.listActive());
    if (
      !shouldAutoPromote({
        source: input.source,
        sensitivity: highest,
        conflicts,
        promote: input.promote,
      })
    ) {
      const inbox = await store.insertInbox({
        title,
        body: text,
        source: input.source,
        scopeKind,
        scopeId,
        sensitivity: allHits.length > 0 ? "public" : highest,
        redacted: allHits.length > 0 ? 1 : 0,
        queueStatus: "proposed",
        conflictIds: conflicts.map((item) => item.id),
        sourceKey: collectedSourceKey,
      });
      for (const hit of allHits) await store.addRedaction(input.source, hit.type, inbox.id);
      await store.audit(input.actor, "memory.queued", inbox.id);
      return {
        status: "queued",
        inboxId: inbox.id,
        redacted: inbox.redacted === 1,
        queued: true,
        conflicts: conflicts.map((item) => item.id),
        hits: allHits.map(({ type, line, field }) => ({ type, line, field })),
      };
    }

    const stored = await this.storeScopeDocument(store, {
      scopeKind,
      scopeId,
      title,
      body: text,
      source: input.source,
      actor: input.actor,
      expectedRev: input.expectedRev,
      sensitivity: allHits.length > 0 ? "public" : highest,
    });
    if (stored.outcome === "conflict") {
      return { status: "conflict", inboxId: "", redacted: allHits.length > 0, queued: false, conflicts: [], currentRev: stored.currentRev };
    }
    if (stored.outcome === "error") {
      return { status: "error", inboxId: "", redacted: allHits.length > 0, queued: false, conflicts: [], hits: allHits.map(({ type, line, field }) => ({ type, line, field })) };
    }
    return {
      status: stored.outcome,
      inboxId: "",
      memoryId: stored.memory.id,
      rev: stored.memory.rev,
      redacted: allHits.length > 0,
      queued: false,
      conflicts: conflicts.map((item) => item.id),
      hits: allHits.map(({ type, line, field }) => ({ type, line, field })),
    };
  }

  /** 事务内覆盖某一作用域的正式记忆（含审计与来源删除可选）。事务可由调用方的外层事务合并。 */
  private async storeScopeDocument(store: Store, input: {
    scopeKind: MemoryScopeKind;
    scopeId: string;
    title: string;
    body: string;
    source: string;
    actor: string;
    expectedRev?: number;
    sensitivity: Sensitivity;
    deleteInboxIds?: string[];
    auditAction?: string;
  }): Promise<
    | { outcome: "stored" | "unchanged"; memory: MemoryRecord }
    | { outcome: "conflict"; currentRev: number }
    | { outcome: "error" }
  > {
    try {
      return await store.transaction(async (tx) => {
        await tx.lockScope(input.scopeKind, input.scopeId);
        const sameScope = await tx.listActiveByScope(input.scopeKind, input.scopeId);
        const currentRev = sameScope[0]?.rev ?? 0;
        if (input.expectedRev !== undefined && input.expectedRev !== currentRev) {
          return { outcome: "conflict" as const, currentRev };
        }
        const contentHash = sha256(`${input.title}\n${input.body}`);
        const now = nowIso();
        const keep = sameScope[0];
        let memory: MemoryRecord;
        let unchanged = false;
        if (keep && keep.contentHash === contentHash && keep.sensitivity === input.sensitivity) {
          memory = keep;
          unchanged = true;
        } else {
          memory = keep
            ? {
                ...keep,
                rev: keep.rev + 1,
                title: input.title,
                body: input.body,
                sensitivity: input.sensitivity,
                status: "active",
                source: input.source,
                contentHash,
                supersededBy: null,
                updatedAt: now,
                forgottenAt: null,
              }
            : {
                id: newId("mem"),
                rev: 1,
                title: input.title,
                body: input.body,
                scopeKind: input.scopeKind,
                scopeId: input.scopeId,
                sensitivity: input.sensitivity,
                status: "active",
                source: input.source,
                originNode: this.nodeId(),
                contentHash,
                supersededBy: null,
                createdAt: now,
                updatedAt: now,
                forgottenAt: null,
              };
          await tx.upsertMemory(memory);
          for (const extra of sameScope) {
            if (extra.id === memory.id) continue;
            await tx.upsertMemory({
              ...extra,
              rev: extra.rev + 1,
              status: "forgotten",
              supersededBy: memory.id,
              updatedAt: now,
              forgottenAt: now,
            });
          }
        }
        await tx.audit(input.actor, input.auditAction ?? "memory.store", memory.id);
        for (const inboxId of input.deleteInboxIds ?? []) {
          await tx.deleteInbox(inboxId);
        }
        return { outcome: unchanged ? ("unchanged" as const) : ("stored" as const), memory };
      });
    } catch (error) {
      if (error instanceof RevisionConflict) return { outcome: "conflict", currentRev: error.currentRev };
      return { outcome: "error" };
    }
  }

  /**
   * 管理台“确认所选来源”：单事务校验来源、扫描正文、校验 rev、写入正式记忆、删除来源。
   * 冲突或任意失败都保留正式记忆与全部来源原状。
   */
  async confirmSources(input: {
    ids: string[];
    body: string;
    title?: string;
    actor: string;
    expectedRev?: number;
    draftId?: string;
  }): Promise<{
    status: "stored" | "unchanged" | "conflict" | "rejected" | "error";
    memoryId?: string;
    rev?: number;
    currentRev?: number;
    redacted?: boolean;
    queued: boolean;
    conflicts: string[];
    error?: string;
    draftId?: string;
    hits?: Array<{ type: string; line?: number; field?: string }>;
  }> {
    if (!input.ids.length || !input.body.trim()) {
      return { status: "error", queued: false, conflicts: [], error: "ids and body required" };
    }
    if (new Set(input.ids).size !== input.ids.length) {
      return { status: "error", queued: false, conflicts: [], error: "duplicate source ids" };
    }
    // C-05：人工确认批量上限——超限整体拒绝、零写入，避免超大单事务阻塞队列。
    const MAX_CONFIRM_SOURCES = 100;
    if (input.ids.length > MAX_CONFIRM_SOURCES) {
      return {
        status: "error",
        queued: false,
        conflicts: [],
        error: `一次最多确认 ${MAX_CONFIRM_SOURCES} 条来源（本次 ${input.ids.length} 条）；请分批勾选并提交`,
      };
    }
    const sources: InboxRecord[] = [];
    for (const id of input.ids) {
      const item = await this.store.getInbox(id);
      if (!item) return { status: "error", queued: false, conflicts: [], error: "source not found" };
      sources.push(item);
    }
    const first = sources[0]!;
    if (
      sources.some(
        (item) =>
          item.queueStatus !== "proposed" ||
          item.sensitivity === "secret" ||
          item.scopeKind !== first.scopeKind ||
          item.scopeId !== first.scopeId,
      )
    ) {
      return { status: "error", queued: false, conflicts: [], error: "sources must be safe and in the same scope" };
    }

    // 草稿路径复核（P0-01）：draft 模式校验草稿状态与来源集合；manual 模式拒绝绕过待审草稿。
    let draftApplies: DistillDraft | undefined;
    if (input.draftId !== undefined) {
      const draft = await this.store.getDraft(input.draftId);
      if (!draft) {
        return { status: "error", queued: false, conflicts: [], error: "草稿不存在或已删除" };
      }
      if (draft.status !== "pending") {
        return { status: "error", queued: false, conflicts: [], error: `草稿状态为 ${draft.status}，过期草稿禁止直接提交，请重新整理` };
      }
      if (draft.scopeKind !== first.scopeKind || draft.scopeId !== first.scopeId) {
        return { status: "error", queued: false, conflicts: [], error: "草稿作用域与所选材料不一致" };
      }
      const expected = [...draft.sourceIds].sort();
      const actual = [...input.ids].sort();
      if (expected.join("\u0000") !== actual.join("\u0000")) {
        return { status: "error", queued: false, conflicts: [], error: "提交的来源集合与草稿记录不一致，请重新核对草稿来源" };
      }
      draftApplies = draft;
    } else {
      const pending = await this.store.latestDraft(first.scopeKind, first.scopeId);
      if (pending?.status === "pending") {
        return { status: "error", queued: false, conflicts: [], error: "该作用域存在待审核草稿：请通过草稿入口审核提交，或先废弃草稿再手工整理", draftId: pending.id };
      }
    }

    const scanned = this.config.security.scanEnabled
      ? scanAndRedact(input.body)
      : { cleanText: input.body, hits: [], highest: "public" as const };
    const titleScan = this.config.security.scanEnabled
      ? scanAndRedact(input.title ?? "")
      : { cleanText: input.title ?? "", hits: [], highest: "public" as const };
    const allHits = [
      ...scanned.hits.map((hit) => ({ ...hit, field: "body" })),
      ...titleScan.hits.map((hit) => ({ ...hit, field: "title" })),
    ];
    const highest =
      scanned.highest === "secret" || titleScan.highest === "secret"
        ? "secret"
        : scanned.highest === "pii" || titleScan.highest === "pii"
          ? "pii"
          : scanned.highest;
    // 二次验证：管理员编辑稿替换后不得再命中规则
    const residue = secondPassHits(scanned.cleanText, titleScan.cleanText);
    if (
      (highest === "secret" && allHits.some((hit) => hit.type === "high_entropy" || hit.type === "private_key_incomplete")) ||
      residue.length > 0
    ) {
      return {
        status: "rejected",
        redacted: true,
        queued: false,
        conflicts: [],
        hits: [
          ...allHits.map(({ type, line, field }) => ({ type, line, field })),
          ...residue,
        ],
      };
    }
    const text = scanned.cleanText.trim();
    const title = titleScan.cleanText.trim() || officialTitle(first.scopeKind, first.scopeId, text);
    const sensitivity: Sensitivity = allHits.length > 0 ? "public" : highest;

    try {
      const outcome = await this.store.transaction(async (store) => {
        await store.lockScope(first.scopeKind, first.scopeId);
        // 事务内复核来源仍存在、状态未变、仍在同一作用域（归并可能已移动材料）
        const freshSources: InboxRecord[] = [];
        for (const id of input.ids) {
          const item = await store.getInbox(id);
          if (
            !item ||
            item.queueStatus !== "proposed" ||
            item.sensitivity === "secret" ||
            item.scopeKind !== first.scopeKind ||
            item.scopeId !== first.scopeId
          ) {
            return { status: "error" as const, queued: false, conflicts: [], error: "source changed" };
          }
          freshSources.push(item);
        }
        // 第五轮修复（来源内容二次复核）：sensitivity 标记可能过期或被篡改
        // （legacy 行、备份导入行、被直接改库的 public 行），确认事务内必须对每条 fresh
        // 来源的标题与正文重新安全扫描；任一命中即整批拒绝，正式记忆、全部来源与审计保持
        // 原状。错误信息只报命中类型与数量，不回显来源正文。
        // 无条件执行：与 secondPassHits 的最终安全门一致，不随 security.scanEnabled 关闭
        // ——扫描开关只省掉入队时的替换劳动，不能豁免确认时的来源安全复核。
        {
          const sourceHits: Array<{ type: string; line?: number; field: string }> = [];
          for (const item of freshSources) {
            for (const hit of scanAndRedact(item.body).hits) sourceHits.push({ type: hit.type, line: hit.line, field: "sourceBody" });
            for (const hit of scanAndRedact(item.title).hits) sourceHits.push({ type: hit.type, line: hit.line, field: "sourceTitle" });
          }
          if (sourceHits.length > 0) {
            const kinds = [...new Set(sourceHits.map((hit) => hit.type))].join("/");
            return {
              status: "rejected" as const,
              redacted: true,
              queued: false,
              conflicts: [],
              hits: sourceHits,
              error: `来源标题或正文安全复核未通过（${sourceHits.length} 处命中：${kinds}）：敏感标记可能过期，已整批拒绝并保留全部来源；请逐条拒收或重新蒸馏`,
            };
          }
        }
        const sameScope = await store.listActiveByScope(first.scopeKind, first.scopeId);
        const currentRev = sameScope[0]?.rev ?? 0;
        // B-03：草稿快照在确认事务内原子复核——status、作用域、来源集合、expectedRev、
        // 每条来源的 title+body 指纹都必须与草稿完全一致；manual 模式同样在事务内
        // 复核不存在待审草稿。markStaleIfChanged 只是列表提示，不承担写入安全边界。
        if (input.draftId !== undefined) {
          const draft = await store.getDraft(input.draftId);
          if (!draft) {
            return { status: "error" as const, queued: false, conflicts: [], error: "草稿不存在或已删除", draftId: input.draftId };
          }
          if (draft.status !== "pending") {
            return { status: "error" as const, queued: false, conflicts: [], error: `草稿状态为 ${draft.status}，过期草稿禁止直接提交，请重新整理`, draftId: draft.id };
          }
          if (draft.scopeKind !== first.scopeKind || draft.scopeId !== first.scopeId) {
            return { status: "error" as const, queued: false, conflicts: [], error: "草稿作用域与所选材料不一致", draftId: draft.id };
          }
          const expected = [...draft.sourceIds].sort();
          const actual = [...input.ids].sort();
          if (expected.join("\u0000") !== actual.join("\u0000")) {
            return { status: "error" as const, queued: false, conflicts: [], error: "提交的来源集合与草稿记录不一致，请重新核对草稿来源", draftId: draft.id };
          }
          if (input.expectedRev !== undefined && input.expectedRev !== draft.expectedRev) {
            return {
              status: "error" as const,
              queued: false,
              conflicts: [],
              error: `请求的 expectedRev（${input.expectedRev}）与草稿 expectedRev（${draft.expectedRev}）不一致：草稿已过期，禁止换新 rev 提交；请废弃后重新生成或从最新正文手工整理`,
              draftId: draft.id,
            };
          }
          if (currentRev !== draft.expectedRev) {
            return { status: "conflict" as const, queued: false, conflicts: [], currentRev, draftId: draft.id };
          }
          if (!draft.sourceIds.length || draft.sourceFingerprints.length !== draft.sourceIds.length) {
            return {
              status: "error" as const,
              queued: false,
              conflicts: [],
              error: "草稿缺少完整的来源指纹快照，无法证明快照未变化；请废弃后重新生成或手工整理",
              draftId: draft.id,
            };
          }
          for (const [index, sourceId] of draft.sourceIds.entries()) {
            const item = freshSources.find((row) => row.id === sourceId);
            if (!item) {
              return { status: "error" as const, queued: false, conflicts: [], error: "source changed" };
            }
            const actualFingerprint = `${item.id}:${sha256(`${item.title}\n${item.body}`)}`;
            if (draft.sourceFingerprints[index] !== actualFingerprint) {
              return {
                status: "error" as const,
                queued: false,
                conflicts: [],
                error: "来源内容与草稿快照不一致（标题或正文已变化）：请废弃草稿后重新生成",
                draftId: draft.id,
              };
            }
          }
        } else {
          const pending = await store.latestDraft(first.scopeKind, first.scopeId);
          if (pending?.status === "pending") {
            return {
              status: "error" as const,
              queued: false,
              conflicts: [],
              error: "该作用域存在待审核草稿：请通过草稿入口审核提交，或先废弃草稿再手工整理",
              draftId: pending.id,
            };
          }
          if (input.expectedRev !== undefined && input.expectedRev !== currentRev) {
            return { status: "conflict" as const, queued: false, conflicts: [], currentRev };
          }
          if (input.expectedRev === undefined && currentRev > 0) {
            return { status: "conflict" as const, queued: false, conflicts: [], currentRev };
          }
        }
        const contentHash = sha256(`${title}\n${text}`);
        const now = nowIso();
        const keep = sameScope[0];
        let memory: MemoryRecord;
        let unchanged = false;
        if (keep && keep.contentHash === contentHash && keep.sensitivity === sensitivity) {
          memory = keep;
          unchanged = true;
        } else {
          memory = keep
            ? {
                ...keep,
                rev: keep.rev + 1,
                title,
                body: text,
                sensitivity,
                status: "active",
                source: "ui",
                contentHash,
                supersededBy: null,
                updatedAt: now,
                forgottenAt: null,
              }
            : {
                id: newId("mem"),
                rev: 1,
                title,
                body: text,
                scopeKind: first.scopeKind,
                scopeId: first.scopeId,
                sensitivity,
                status: "active",
                source: "ui",
                originNode: this.nodeId(),
                contentHash,
                supersededBy: null,
                createdAt: now,
                updatedAt: now,
                forgottenAt: null,
              };
          await store.upsertMemory(memory);
          for (const extra of sameScope) {
            if (extra.id === memory.id) continue;
            await store.upsertMemory({
              ...extra,
              rev: extra.rev + 1,
              status: "forgotten",
              supersededBy: memory.id,
              updatedAt: now,
              forgottenAt: now,
            });
          }
        }
        await store.audit(input.actor, "memory.resolve", memory.id);
        if (draftApplies) {
          await store.upsertDraft({ ...draftApplies, status: "applied", updatedAt: now });
          await store.audit(input.actor, "distill.applied", draftApplies.id);
        }
        for (const source of sources) {
          await store.deleteInbox(source.id);
        }
        return {
          status: unchanged ? ("unchanged" as const) : ("stored" as const),
          memoryId: memory.id,
          rev: memory.rev,
          redacted: allHits.length > 0,
          queued: false,
          conflicts: [],
          hits: allHits.map(({ type, line, field }) => ({ type, line, field })),
        };
      });
      // B-02：草稿提交遇到 rev 冲突时把草稿标记为过期，不给旧 draftId 换新 rev 重试
      if (outcome.status === "conflict") {
        await this.markDraftStaleAfterConflict(input, outcome.currentRev);
      }
      return outcome;
    } catch {
      return { status: "error", queued: false, conflicts: [], error: "resolve failed" };
    }
  }

  /** B-02：草稿提交遇到 rev 冲突后的尽力过期标记；失败不影响主结果。 */
  private async markDraftStaleAfterConflict(input: { draftId?: string }, currentRev?: number): Promise<void> {
    if (input.draftId === undefined) return;
    try {
      const draft = await this.store.getDraft(input.draftId);
      if (draft && draft.status === "pending") {
        await this.store.upsertDraft({
          ...draft,
          status: "stale",
          staleReason: `提交时正式记忆已推进到 rev ${currentRev ?? 0}，草稿过期；请废弃后重新生成或从最新正文手工整理`,
          updatedAt: nowIso(),
        });
        await this.store.audit("system", "distill.stale_on_conflict", draft.id);
      }
    } catch {
      // 尽力而为：主结果已确定，过期标记失败只留待列表刷新兜底
    }
  }

  async promoteInbox(inboxId: string, actor: string, expectedRev?: number): Promise<MemoryRecord | undefined> {
    return this.store.transaction(async (store) => {
    const inbox = await store.getInbox(inboxId);
    if (!inbox || inbox.sensitivity === "secret" || inbox.queueStatus === "rejected") return undefined;
    await store.lockScope(inbox.scopeKind, inbox.scopeId);
    const sameScope = await store.listActiveByScope(inbox.scopeKind, inbox.scopeId);
    const currentRev = sameScope[0]?.rev ?? 0;
    if ((expectedRev !== undefined && expectedRev !== currentRev) || (expectedRev === undefined && currentRev > 0 && isOfficialDistillSource(inbox.source))) {
      throw new RevisionConflict(currentRev);
    }
    const keep = sameScope[0];
    const now = nowIso();
    const memory: MemoryRecord = keep
      ? {
          ...keep,
          rev: keep.rev + 1,
          title: inbox.title,
          body: inbox.body,
          sensitivity: inbox.sensitivity,
          status: "active",
          source: inbox.source,
          contentHash: sha256(`${inbox.title}\n${inbox.body}`),
          supersededBy: null,
          updatedAt: now,
          forgottenAt: null,
        }
      : {
          id: newId("mem"),
          rev: 1,
          title: inbox.title,
          body: inbox.body,
          scopeKind: inbox.scopeKind,
          scopeId: inbox.scopeId,
          sensitivity: inbox.sensitivity,
          status: "active",
          source: inbox.source,
          originNode: this.nodeId(),
          contentHash: sha256(`${inbox.title}\n${inbox.body}`),
          supersededBy: null,
          createdAt: now,
          updatedAt: now,
          forgottenAt: null,
        };
    await store.upsertMemory(memory);
    for (const extra of sameScope) {
      if (extra.id === memory.id) continue;
      await store.upsertMemory({
        ...extra,
        rev: extra.rev + 1,
        status: "forgotten",
        supersededBy: memory.id,
        updatedAt: now,
        forgottenAt: now,
      });
    }
    await store.deleteInbox(inbox.id);
    await store.audit(actor, "memory.promote", memory.id);
    return memory;
    });
  }

  async rejectInbox(inboxId: string, actor: string): Promise<boolean> {
    const inbox = await this.store.getInbox(inboxId);
    if (!inbox) return false;
    await this.store.rejectInbox(inboxId);
    await this.store.audit(actor, "memory.reject", inboxId);
    return true;
  }

  async retireNonDistilled(): Promise<number> {
    let removed = 0;
    for (const item of await this.store.listActive()) {
      if (isOfficialDistillSource(item.source)) continue;
      await this.forget(item.id, "system:retire-fragments");
      removed += 1;
    }
    return removed;
  }

  async search(query: string, actor: string, limit = 8, filter?: ScopeFilter): Promise<MemoryRecord[]> {
    const raw = await this.store.searchMemories(query, limit, filter);
    const filtered = raw.filter((item) => this.visibleToAgent(item));
    await this.store.audit(actor, "memory.search", scanAndRedact(query).cleanText.slice(0, 80));
    return filtered.map((item) => this.forAgent(item));
  }

  async get(
    actor: string,
    opts: { id?: string; scopeKind?: MemoryScopeKind; scopeId?: string },
  ): Promise<MemoryRecord[]> {
    if (!opts.id && !opts.scopeKind && !opts.scopeId) return [];
    const raw = opts.id
      ? [await this.store.getMemory(opts.id)].filter((item): item is MemoryRecord => Boolean(item))
      : await this.store.listMemories(50, { scopeKind: opts.scopeKind, scopeId: opts.scopeId });
    const filtered = raw.filter((item) => item.status !== "forgotten" && this.visibleToAgent(item));
    await this.store.audit(
      actor,
      "memory.get",
      opts.id || `${opts.scopeKind ?? ""}:${opts.scopeId ?? ""}`.slice(0, 80),
    );
    return filtered.map((item) => this.forAgent(item));
  }

  async forget(id: string, actor: string): Promise<boolean> {
    const current = await this.store.getMemory(id);
    if (!current) return false;
    await this.store.upsertMemory({
      ...current,
      rev: current.rev + 1,
      status: "forgotten",
      updatedAt: nowIso(),
      forgottenAt: nowIso(),
    });
    await this.store.audit(actor, "memory.forget", id);
    return true;
  }

  async list(limit = 100, filter?: ScopeFilter): Promise<MemoryRecord[]> {
    return (await this.store.listMemories(limit, filter)).map((item) => this.forUi(item));
  }

  async listForAgent(limit = 100, filter?: ScopeFilter): Promise<MemoryRecord[]> {
    return (await this.list(limit, filter)).filter((item) => this.visibleToAgent(item));
  }

  async ingestCollected(
    source: string,
    files: Array<{ path: string; text: string; scopeId?: string }>,
  ): Promise<CollectResult> {
    let ingested = 0;
    let queued = 0;
    let skipped = 0;
    let redacted = 0;
    let errors = 0;
    for (const file of files) {
      const text = file.text.trim();
      if (text.length < 8) {
        skipped += 1;
        continue;
      }
      const scopeKind: MemoryScopeKind = file.scopeId ? "project" : "personal";
      const scopeId = file.scopeId ?? "";
      const rawHash = sha256(text);
      // 稳定来源键策略（P0-03/P0-04/C-06）：canonical 绝对路径跨作用域查最近指纹比较内容；
      // 内容不变则无论归属如何变化都跳过（指纹保留原作用域）；内容变化才入队一个新版本。
      // UNC/WSL 风格/相对路径等无法证明唯一的键继续按作用域查重。
      const inboxSourceKey = canonicalSourceKey(file.path) ?? file.path;
      const globalKey = sourceKeyIsGlobal(file.path) ? inboxSourceKey : undefined;
      const fp = globalKey
        ? await this.store.latestFingerprintGlobal(source, globalKey, SCAN_RULES_VERSION)
        : await this.store.latestFingerprint(source, file.path, scopeKind, scopeId, SCAN_RULES_VERSION);
      if (fp && fp.contentHash === rawHash) {
        try {
          await this.store.touchFingerprint(fp.id, "unchanged");
          skipped += 1;
        } catch {
          errors += 1;
        }
        continue;
      }
      // 单文件一个事务：材料入队/写入与指纹登记同生共死。
      // 指纹登记失败必须整体回滚，否则重扫会因缺少指纹而重复入队。
      try {
        const result = await this.store.transaction(async (tx) => {
          const outcome = await this.rememberOn(tx, {
            title: clipTitle(text, file.path),
            body: text,
            source,
            scopeKind,
            scopeId,
            actor: `collector:${source}`,
            sourceKey: inboxSourceKey,
          });
          if (outcome.status === "error") throw new RememberOutcomeError(outcome);
          if (outcome.status !== "unchanged") {
            // 指纹登记使用与查找一致的规范化来源键，保证跨轮次可命中。
            await tx.insertFingerprint({
              collector: source,
              sourceKey: globalKey ?? file.path,
              scopeKind,
              scopeId,
              contentHash: rawHash,
              rulesVersion: SCAN_RULES_VERSION,
              lastStatus: outcome.status,
            });
          }
          return outcome;
        });
        if (result.status === "unchanged") skipped += 1;
        else if (result.status === "rejected") redacted += 1;
        else if (result.memoryId) ingested += 1;
        else if (result.queued) queued += 1;
        else skipped += 1;
      } catch {
        // 材料与指纹必须一致：事务失败则材料也不能留下，下一轮重扫重试。
        skipped += 1;
        errors += 1;
      }
    }
    return { source, scannedFiles: files.length, ingested, queued, skipped, redacted, errors };
  }

  async issueKey(name: string, tools = "memory.search,memory.remember,memory.forget,memory.list,memory.get") {
    const token = `ol_${crypto.randomUUID().replaceAll("-", "")}`;
    const record = {
      id: newId("key"),
      name,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 8),
      scopes: "global,project,personal",
      tools,
      createdAt: nowIso(),
      lastUsedAt: null,
    };
    await this.store.insertKey(record);
    await this.store.audit("admin", "key.create", record.id);
    return { ...record, token };
  }

  forAgent(memory: MemoryRecord): MemoryRecord {
    if (memory.sensitivity === "secret") {
      return { ...memory, body: "[REDACTED:secret]", title: memory.title };
    }
    return memory;
  }

  forUi(memory: MemoryRecord): MemoryRecord {
    return this.forAgent(memory);
  }

  private visibleToAgent(item: MemoryRecord): boolean {
    if (item.sensitivity === "secret") return false;
    if (item.sensitivity === "pii") return false;
    if (item.sensitivity === "internal" && !this.config.security.allowInternalInSearch) return false;
    return SAFE_LEVELS.has(item.sensitivity);
  }
}
