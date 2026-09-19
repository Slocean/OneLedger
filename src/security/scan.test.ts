import { describe, expect, it } from "vitest";
import { scanAndRedact } from "./scan.js";

describe("scanAndRedact", () => {
  it("redacts openai keys and keeps surrounding text", () => {
    const result = scanAndRedact("prefer pnpm and never commit sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.highest).toBe("secret");
    expect(result.cleanText).toContain("[REDACTED:openai_key]");
    expect(result.cleanText).toContain("prefer pnpm");
    expect(result.cleanText).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("leaves ordinary notes public", () => {
    const result = scanAndRedact("Use SQLite locally and Postgres on the hub.");
    expect(result.highest).toBe("public");
    expect(result.hits).toEqual([]);
  });
});
