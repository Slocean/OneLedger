import type { CollectResult, MemoryRecord, MemoryScopeKind, ScopeFilter, Sensitivity } from "../types.js";
import type { AppConfig } from "../types.js";
import { findConflicts, shouldAutoPromote } from "../distill/conflict.js";
import { scanAndRedact } from "../security/scan.js";
import { clipTitle, hashToken, newId, nowIso, sha256 } from "../util.js";
import { Store } from "./store.js";

const SAFE_LEVELS = new Set<Sensitivity>(["public", "internal"]);

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
  }> {
    const scanned = this.config.security.scanEnabled
      ? scanAndRedact(input.body)
      : { cleanText: input.body, hits: [], highest: "public" as const };

    if (scanned.highest === "secret") {
      const inbox = await this.store.insertInbox({
        title: clipTitle(scanned.cleanText, "Redacted note"),
        body: scanned.cleanText,
        source: input.source,
        scopeKind: input.scopeKind ?? "personal",
        scopeId: input.scopeId ?? "",
        sensitivity: "secret",
        redacted: 1,
        queueStatus: "rejected",
        conflictIds: [],
      });
      for (const hit of scanned.hits) {
        await this.store.addRedaction(input.source, hit.type, inbox.id);
      }
      await this.store.audit(input.actor, "remember.redacted", inbox.id);
      return { inboxId: inbox.id, redacted: true, queued: false, conflicts: [] };
    }

    const text = scanned.cleanText.trim();
    const scopeKind = input.scopeKind ?? "global";
    const scopeId = input.scopeId ?? "";
    const title = input.title?.trim() || officialTitle(scopeKind, scopeId, text);
    const hash = sha256(`${title}\n${text}`);
    const existing = await this.store.findActiveByHash(hash);
    if (existing) {
      await this.store.audit(input.actor, "remember.dedup", existing.id);
      return { inboxId: "", memoryId: existing.id, redacted: false, queued: false, conflicts: [] };
    }

    const conflicts = findConflicts(text, title, await this.store.listActive());
    const inbox = await this.store.insertInbox({
      title,
      body: text,
      source: input.source,
      scopeKind,
      scopeId,
      sensitivity: scanned.highest,
      redacted: scanned.hits.length > 0 ? 1 : 0,
      queueStatus: "proposed",
      conflictIds: conflicts.map((item) => item.id),
    });

    if (
      shouldAutoPromote({
        source: input.source,
        sensitivity: scanned.highest,
        conflicts,
        promote: input.promote,
      })
    ) {
      const memory = await this.promoteInbox(inbox.id, input.actor);
      return {
        inboxId: inbox.id,
        memoryId: memory?.id,
        redacted: inbox.redacted === 1,
        queued: false,
        conflicts: conflicts.map((item) => item.id),
      };
    }

    await this.store.audit(input.actor, "memory.queued", inbox.id);
    return {
      inboxId: inbox.id,
      redacted: inbox.redacted === 1,
      queued: true,
      conflicts: conflicts.map((item) => item.id),
    };
  }

  async promoteInbox(inboxId: string, actor: string, _supersedeIds: string[] = []): Promise<MemoryRecord | undefined> {
    const inbox = await this.store.getInbox(inboxId);
    if (!inbox || inbox.sensitivity === "secret" || inbox.queueStatus === "rejected") return undefined;

    const sameScope = await this.store.listActiveByScope(inbox.scopeKind, inbox.scopeId);
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
    await this.store.upsertMemory(memory);
    for (const extra of sameScope) {
      if (extra.id === memory.id) continue;
      await this.store.upsertMemory({
        ...extra,
        rev: extra.rev + 1,
        status: "forgotten",
        supersededBy: memory.id,
        updatedAt: now,
        forgottenAt: now,
      });
    }
    await this.store.deleteInbox(inbox.id);
    await this.store.audit(actor, "memory.promote", memory.id);
    return memory;
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
    await this.retireNonDistilled();
    const raw = await this.store.searchMemories(query, limit, filter);
    const filtered = raw.filter((item) => this.visibleToAgent(item));
    await this.store.audit(actor, "memory.search", query.slice(0, 80));
    return filtered.map((item) => this.forAgent(item));
  }

  async get(
    actor: string,
    opts: { id?: string; scopeKind?: MemoryScopeKind; scopeId?: string },
  ): Promise<MemoryRecord[]> {
    if (!opts.id && !opts.scopeKind && !opts.scopeId) return [];
    await this.retireNonDistilled();
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
    await this.retireNonDistilled();
    return (await this.store.listMemories(limit, filter)).map((item) => this.forUi(item));
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
      const result = await this.remember({
        title: clipTitle(text, file.path),
        body: text,
        source,
        scopeKind: file.scopeId ? "project" : "personal",
        scopeId: file.scopeId ?? file.path,
        actor: `collector:${source}`,
      });
      if (result.redacted) redacted += 1;
      else if (result.memoryId) ingested += 1;
      else if (result.queued) queued += 1;
      else skipped += 1;
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
