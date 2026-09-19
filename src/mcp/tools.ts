import { z } from "zod";
import type { MemoryService } from "../memory/service.js";

export const toolSchemas = {
  "memory.search": {
    description: "Search durable shared memories. Results never include secret-classified text.",
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  "memory.remember": {
    description: "Store a candidate memory. Secrets are redacted before persistence and never recalled.",
    input: z.object({
      body: z.string().min(1),
      title: z.string().optional(),
      scopeKind: z.enum(["global", "project", "personal"]).optional(),
      scopeId: z.string().optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        title: { type: "string" },
        scopeKind: { type: "string", enum: ["global", "project", "personal"] },
        scopeId: { type: "string" },
      },
      required: ["body"],
    },
  },
  "memory.forget": {
    description: "Tombstone a memory so it stops being recalled and will sync as forgotten.",
    input: z.object({ id: z.string().min(1) }),
    jsonSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  "memory.list": {
    description: "List memory titles only, without bodies.",
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    jsonSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
} as const;

export type ToolName = keyof typeof toolSchemas;

export async function callTool(
  service: MemoryService,
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<unknown> {
  if (name === "memory.search") {
    const input = toolSchemas["memory.search"].input.parse(args);
    return service.search(input.query, actor, input.limit ?? 8);
  }
  if (name === "memory.remember") {
    const input = toolSchemas["memory.remember"].input.parse(args);
    return service.remember({
      body: input.body,
      title: input.title,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      source: `mcp:${actor}`,
      actor,
    });
  }
  if (name === "memory.forget") {
    const input = toolSchemas["memory.forget"].input.parse(args);
    return { ok: await service.forget(input.id, actor) };
  }
  if (name === "memory.list") {
    const input = toolSchemas["memory.list"].input.parse(args);
    const items = await service.list(input.limit ?? 20);
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      scopeKind: item.scopeKind,
      updatedAt: item.updatedAt,
    }));
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function allowedTools(csv: string): Set<string> {
  return new Set(csv.split(",").map((part) => part.trim()).filter(Boolean));
}
