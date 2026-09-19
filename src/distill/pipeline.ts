import type { AppConfig } from "../types.js";

/** Distillation is done by the connecting agent over MCP, not by OneLedger. */
export async function distillText(_config: AppConfig, text: string): Promise<string> {
  return text.trim();
}
