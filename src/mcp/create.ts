import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APP_VERSION } from "../types.js";
import type { MemoryService } from "../memory/service.js";
import { allowedTools, callTool, toolSchemas } from "./tools.js";

export function createMcpServer(service: MemoryService, actor: string, permitted?: Set<string>): McpServer {
  const server = new McpServer({ name: "oneledger", version: APP_VERSION });
  for (const [name, spec] of Object.entries(toolSchemas)) {
    if (permitted && !permitted.has(name)) continue;
    server.registerTool(
      name,
      { description: spec.description, inputSchema: spec.input },
      async (args: Record<string, unknown>) => {
        const result = await callTool(service, name, args, actor);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
  return server;
}

export { allowedTools };
