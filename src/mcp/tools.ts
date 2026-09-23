import { z } from "zod";
import type { MemoryService } from "../memory/service.js";

export const toolSchemas = {
  "memory.search": {
    description:
      "Search durable shared memories. Results never include secret-classified text. Filter with scopeKind and scopeId (repository name).",
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      scopeKind: z.enum(["global", "project", "personal"]).optional(),
      scopeId: z.string().optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        scopeKind: { type: "string", enum: ["global", "project", "personal"] },
        scopeId: { type: "string" },
      },
      required: ["query"],
    },
  },
  "memory.remember": {
    description:
      "Replace the distilled write-up for this scope. Read the current rev first and pass expectedRev to protect concurrent edits. Send the full refined text, not one fact per call. OneLedger does not summarize.",
    input: z.object({
      body: z.string().min(1),
      title: z.string().optional(),
      scopeKind: z.enum(["global", "project", "personal"]).optional(),
      scopeId: z.string().optional(),
      expectedRev: z.number().int().min(0).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        title: { type: "string" },
        scopeKind: { type: "string", enum: ["global", "project", "personal"] },
        scopeId: { type: "string" },
        expectedRev: { type: "integer", minimum: 0 },
      },
      required: ["body"],
    },
  },
  "memory.forget": {
    description: "Remove an official distilled memory so it is no longer recalled.",
    input: z.object({ id: z.string().min(1) }),
    jsonSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  "memory.list": {
    description: "List memory titles only, without bodies. Includes scopeId. Filter with scopeKind and scopeId.",
    input: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      scopeKind: z.enum(["global", "project", "personal"]).optional(),
      scopeId: z.string().optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        scopeKind: { type: "string", enum: ["global", "project", "personal"] },
        scopeId: { type: "string" },
      },
    },
  },
  "memory.get": {
    description:
      "Read full distilled documents. Pass id, or scopeKind and/or scopeId (repository name). No dummy search query. Results never include secret-classified text.",
    input: z.object({
      id: z.string().optional(),
      scopeKind: z.enum(["global", "project", "personal"]).optional(),
      scopeId: z.string().optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        scopeKind: { type: "string", enum: ["global", "project", "personal"] },
        scopeId: { type: "string" },
      },
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
    return service.search(input.query, actor, input.limit ?? 8, {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
    });
  }
  if (name === "memory.remember") {
    const input = toolSchemas["memory.remember"].input.parse(args);
    return service.remember({
      body: input.body,
      title: input.title,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      expectedRev: input.expectedRev,
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
    const items = await service.listForAgent(input.limit ?? 20, {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
    });
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      scopeKind: item.scopeKind,
      scopeId: item.scopeId,
      updatedAt: item.updatedAt,
    }));
  }
  if (name === "memory.get") {
    const input = toolSchemas["memory.get"].input.parse(args);
    return service.get(actor, {
      id: input.id,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function allowedTools(csv: string): Set<string> {
  const set = new Set(csv.split(",").map((part) => part.trim()).filter(Boolean));
  if (set.has("memory.list") || set.has("memory.search")) set.add("memory.get");
  return set;
}
