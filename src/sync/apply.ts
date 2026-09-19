import type { MemoryRecord } from "../types.js";
import type { Store } from "../memory/store.js";

export async function applyRemoteMemories(store: Store, memories: MemoryRecord[]): Promise<number> {
  let applied = 0;
  for (const memory of memories) {
    if (memory.sensitivity === "secret") continue;
    const current = await store.getMemory(memory.id);
    if (current && current.rev >= memory.rev) continue;
    await store.upsertMemory({
      ...memory,
      supersededBy: memory.supersededBy ?? null,
    });
    applied += 1;
  }
  return applied;
}
