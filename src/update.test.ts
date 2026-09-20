import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("keeps app_update.json valid and aligned with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    const raw = JSON.parse(readFileSync(join(process.cwd(), "app_update.json"), "utf8"));
    const channel = normalizeChannel(raw);
    expect(channel.history[0]?.version).toBe(pkg.version);
    expect(channel.history[0]?.title).toBeTruthy();
    expect(channel.history[0]?.body).toBeTruthy();
  });
});
