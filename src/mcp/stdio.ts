import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VERSION } from "../types.js";
import type { MemoryService } from "../memory/service.js";
import { callTool, toolSchemas } from "./tools.js";

export async function startStdioMcp(service: MemoryService): Promise<void> {
  const server = new McpServer({ name: "oneledger", version: APP_VERSION });
  for (const [name, spec] of Object.entries(toolSchemas)) {
    server.registerTool(
      name,
      { description: spec.description, inputSchema: spec.input },
      async (args: Record<string, unknown>) => {
        const result = await callTool(service, name, args, "stdio");
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
