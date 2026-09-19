import type { AppConfig, CollectResult, MemoryRecord, MemoryScopeKind, Sensitivity } from "../types.js";
import { distillText } from "../distill/pipeline.js";
import { scanAndRedact } from "../security/scan.js";
import { clipTitle, hashToken, newId, nowIso, sha256 } from "../util.js";
import { Store } from "./store.js";

const SAFE_LEVELS = new Set<Sensitivity>(["public", "internal"]);

export interface RememberInput {
  title?: string;
  body: string;
  source: string;
  scopeKind?: MemoryScopeKind;
  scopeId?: string;
  actor: string;
}

export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
  ) {}

  nodeId(): string {
    return this.config.sync.nodeKey.slice(0, 8) || "local";
  }

  async remember(input: RememberInput): Promise<{ inboxId: string; memoryId?: string; redacted: boolean }> {
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
      });
      for (const hit of scanned.hits) {
        await this.store.addRedaction(input.source, hit.type, inbox.id);
      }
      await this.store.audit(input.actor, "remember.redacted", inbox.id);
      return { inboxId: inbox.id, redacted: true };
    }

    const distilled = await distillText(this.config, scanned.cleanText);
    const title = input.title?.trim() || clipTitle(distilled || scanned.cleanText);
    const hash = sha256(`${title}\n${distilled}`);
    const existing = await this.store.findActiveByHash(hash);
    if (existing) {
      await this.store.audit(input.actor, "remember.dedup", existing.id);
      return { inboxId: "", memoryId: existing.id, redacted: false };
    }

    const inbox = await this.store.insertInbox({
      title,
      body: distilled,
      source: input.source,
      scopeKind: input.scopeKind ?? "global",
      scopeId: input.scopeId ?? "",
      sensitivity: scanned.highest,
      redacted: scanned.hits.length > 0 ? 1 : 0,
    });

    const memory = await this.promoteInbox(inbox.id, input.actor);
    return { inboxId: inbox.id, memoryId: memory?.id, redacted: inbox.redacted === 1 };
  }

  async promoteInbox(inboxId: string, actor: string): Promise<MemoryRecord | undefined> {
    const items = await this.store.listInbox(200);
    const inbox = items.find((item) => item.id === inboxId);
    if (!inbox || inbox.sensitivity === "secret") return undefined;

    const memory: MemoryRecord = {
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
      forgottenAt: null,
    };
    await this.store.upsertMemory(memory);
    await this.store.deleteInbox(inbox.id);
    await this.store.audit(actor, "memory.promote", memory.id);
    return memory;
  }

  async search(query: string, actor: string, limit = 8): Promise<MemoryRecord[]> {
    const raw = await this.store.searchMemories(query, limit);
    const filtered = raw.filter((item) => {
      if (item.sensitivity === "secret") return false;
      if (item.sensitivity === "pii") return false;
      if (item.sensitivity === "internal" && !this.config.security.allowInternalInSearch) return false;
      return SAFE_LEVELS.has(item.sensitivity);
    });
    await this.store.audit(actor, "memory.search", query.slice(0, 80));
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

  async list(limit = 100): Promise<MemoryRecord[]> {
    return (await this.store.listMemories(limit)).map((item) => this.forUi(item));
  }

  async ingestCollected(
    source: string,
    files: Array<{ path: string; text: string; scopeId?: string }>,
  ): Promise<CollectResult> {
    let ingested = 0;
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
      else skipped += 1;
    }
    return { source, scannedFiles: files.length, ingested, skipped, redacted };
  }

  async issueKey(name: string, tools = "memory.search,memory.remember,memory.forget") {
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
}
