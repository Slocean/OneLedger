import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MemoryService } from "../memory/service.js";
import { createMcpServer } from "./create.js";

export async function startStdioMcp(service: MemoryService): Promise<void> {
  const server = createMcpServer(service, "stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
