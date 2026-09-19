import type { MemoryRecord } from "../types.js";

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 2),
  );
}

export function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}

export function findConflicts(body: string, title: string, actives: MemoryRecord[], threshold = 0.45): MemoryRecord[] {
  const incoming = tokenSet(`${title}\n${body}`);
  return actives.filter((item) => {
    const score = overlapRatio(incoming, tokenSet(`${item.title}\n${item.body}`));
    return score >= threshold;
  });
}

export function shouldAutoPromote(input: {
  source: string;
  sensitivity: string;
  conflicts: MemoryRecord[];
  promote?: boolean;
}): boolean {
  if (input.promote) return true;
  if (input.sensitivity !== "public") return false;
  if (input.conflicts.length > 0) return false;
  return input.source.startsWith("project:");
}
