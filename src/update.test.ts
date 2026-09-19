import { describe, expect, it } from "vitest";
import { normalizeChannel, versionGt } from "./update.js";

describe("update channel", () => {
  it("compares versions", () => {
    expect(versionGt("0.2.1", "0.2.0")).toBe(true);
    expect(versionGt("0.2.0", "0.2.0")).toBe(false);
    expect(versionGt("0.1.9", "0.2.0")).toBe(false);
  });

  it("normalizes history", () => {
    const channel = normalizeChannel({
      history: [{ version: "v0.2.0", title: "", body: "notes", notice: "hi" }],
    });
    expect(channel.history[0]).toMatchObject({ version: "0.2.0", title: "0.2.0 更新", notice: "hi" });
  });
});
