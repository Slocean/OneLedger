import type { CollectResult, InboxRecord, MemoryRecord, MemoryScopeKind, ScopeFilter, Sensitivity } from "../types.js";
import type { AppConfig } from "../types.js";
import { SCAN_RULES_VERSION } from "../types.js";
import { findConflicts, shouldAutoPromote } from "../distill/conflict.js";
import { scanAndRedact, verifyRedacted } from "../security/scan.js";
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

export function isOfficialDistillSource(source: string): boolean {
  return source === "ui" || source.startsWith("ui:") || source.startsWith("mcp:");
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
    if (!isOfficialDistillSource(input.source)) {
      const existingInbox = await this.store.findCollectedInbox(input.source, collectedScopeKind, collectedScopeId, scanned.cleanText.trim());
      if (existingInbox) {
        return { status: "unchanged", inboxId: existingInbox.id, redacted: existingInbox.redacted === 1, queued: existingInbox.queueStatus === "proposed", conflicts: [] };
      }
    }

    if ((highest === "secret" && unsafeRedaction) || residue.length > 0) {
      const inbox = await this.store.insertInbox({
        title: clipTitle(scanned.cleanText, "Redacted note"),
        body: scanned.cleanText.trim(),
        source: input.source,
        scopeKind: input.scopeKind ?? "personal",
        scopeId: input.scopeId ?? "",
        sensitivity: "secret",
        redacted: 1,
        queueStatus: "rejected",
        conflictIds: [],
      });
      for (const hit of allHits) {
        await this.store.addRedaction(input.source, hit.type, inbox.id);
      }
      for (const hit of residue) {
        await this.store.addRedaction(input.source, hit.type, inbox.id);
      }
      await this.store.audit(input.actor, "remember.redacted", inbox.id);
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
    const currentRev = (await this.store.listActiveByScope(scopeKind, scopeId))[0]?.rev ?? 0;
    if ((input.expectedRev !== undefined && currentRev !== input.expectedRev) || (input.expectedRev === undefined && currentRev > 0 && isOfficialDistillSource(input.source))) {
      return { status: "conflict", inboxId: "", redacted: allHits.length > 0, queued: false, conflicts: [], currentRev };
    }
    const existing = await this.store.findActiveByHash(hash, scopeKind, scopeId);
    if (existing && existing.sensitivity === sensitivity) {
      await this.store.audit(input.actor, "remember.dedup", existing.id);
      return { status: "unchanged", inboxId: "", memoryId: existing.id, rev: existing.rev, redacted: allHits.length > 0, queued: false, conflicts: [], hits: allHits.map(({ type, line, field }) => ({ type, line, field })) };
    }

    const conflicts = findConflicts(text, title, await this.store.listActive());
    if (
      !shouldAutoPromote({
        source: input.source,
        sensitivity: highest,
        conflicts,
        promote: input.promote,
      })
    ) {
      const inbox = await this.store.insertInbox({
        title,
        body: text,
        source: input.source,
        scopeKind,
        scopeId,
        sensitivity: allHits.length > 0 ? "public" : highest,
        redacted: allHits.length > 0 ? 1 : 0,
        queueStatus: "proposed",
        conflictIds: conflicts.map((item) => item.id),
      });
      for (const hit of allHits) await this.store.addRedaction(input.source, hit.type, inbox.id);
      await this.store.audit(input.actor, "memory.queued", inbox.id);
      return {
        status: "queued",
        inboxId: inbox.id,
        redacted: inbox.redacted === 1,
        queued: true,
        conflicts: conflicts.map((item) => item.id),
        hits: allHits.map(({ type, line, field }) => ({ type, line, field })),
      };
    }

    const stored = await this.storeScopeDocument({
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

  /** 事务内覆盖某一作用域的正式记忆（含审计与来源删除可选）。 */
  private async storeScopeDocument(input: {
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
      return await this.store.transaction(async (store) => {
        await store.lockScope(input.scopeKind, input.scopeId);
        const sameScope = await store.listActiveByScope(input.scopeKind, input.scopeId);
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
        await store.audit(input.actor, input.auditAction ?? "memory.store", memory.id);
        for (const inboxId of input.deleteInboxIds ?? []) {
          await store.deleteInbox(inboxId);
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
  }): Promise<{
    status: "stored" | "unchanged" | "conflict" | "rejected" | "error";
    memoryId?: string;
    rev?: number;
    currentRev?: number;
    redacted?: boolean;
    queued: boolean;
    conflicts: string[];
    error?: string;
    hits?: Array<{ type: string; line?: number; field?: string }>;
  }> {
    if (!input.ids.length || !input.body.trim()) {
      return { status: "error", queued: false, conflicts: [], error: "ids and body required" };
    }
    if (new Set(input.ids).size !== input.ids.length) {
      return { status: "error", queued: false, conflicts: [], error: "duplicate source ids" };
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
      return await this.store.transaction(async (store) => {
        await store.lockScope(first.scopeKind, first.scopeId);
        // 事务内复核来源仍存在且状态未变
        for (const id of input.ids) {
          const item = await store.getInbox(id);
          if (!item || item.queueStatus !== "proposed" || item.sensitivity === "secret") {
            return { status: "error" as const, queued: false, conflicts: [], error: "source changed" };
          }
        }
        const sameScope = await store.listActiveByScope(first.scopeKind, first.scopeId);
        const currentRev = sameScope[0]?.rev ?? 0;
        if (input.expectedRev !== undefined && input.expectedRev !== currentRev) {
          return { status: "conflict" as const, queued: false, conflicts: [], currentRev };
        }
        if (input.expectedRev === undefined && currentRev > 0) {
          return { status: "conflict" as const, queued: false, conflicts: [], currentRev };
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
    } catch {
      return { status: "error", queued: false, conflicts: [], error: "resolve failed" };
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
    for (const file of files) {
      const text = file.text.trim();
      if (text.length < 8) {
        skipped += 1;
        continue;
      }
      const scopeKind: MemoryScopeKind = file.scopeId ? "project" : "personal";
      const scopeId = file.scopeId ?? "";
      const rawHash = sha256(text);
      const fp = await this.store.latestFingerprint(source, file.path, scopeKind, scopeId, SCAN_RULES_VERSION);
      if (fp && fp.contentHash === rawHash) {
        await this.store.touchFingerprint(fp.id, "unchanged");
        skipped += 1;
        continue;
      }
      const result = await this.remember({
        title: clipTitle(text, file.path),
        body: text,
        source,
        scopeKind,
        scopeId,
        actor: `collector:${source}`,
      });
      if (result.status === "unchanged") skipped += 1;
      else if (result.status === "error") {
        // 写入失败不得登记指纹，下一轮重试
        skipped += 1;
        continue;
      } else if (result.status === "rejected") redacted += 1;
      else if (result.memoryId) ingested += 1;
      else if (result.queued) queued += 1;
      else skipped += 1;
      if (result.status !== "unchanged") {
        await this.store.insertFingerprint({
          collector: source,
          sourceKey: file.path,
          scopeKind,
          scopeId,
          contentHash: rawHash,
          rulesVersion: SCAN_RULES_VERSION,
          lastStatus: result.status,
        });
      }
    }
    return { source, scannedFiles: files.length, ingested, queued, skipped, redacted };
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
