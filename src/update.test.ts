import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeChannel, pickBestChannel, versionGt } from "./update.js";

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

  it("prefers GitHub over a stale CDN copy", () => {
    const best = pickBestChannel(
      [
        {
          source: "https://cdn.jsdelivr.net/gh/Slocean/OneLedger@main/app_update.json",
          history: [{ version: "0.4.1", title: "old", body: "", notice: "" }],
        },
        {
          source: "https://raw.githubusercontent.com/Slocean/OneLedger/main/app_update.json",
          history: [{ version: "0.4.2", title: "new", body: "", notice: "" }],
        },
      ],
      "0.4.1",
    );
    expect(best?.history[0]?.version).toBe("0.4.2");
  });

  it("rejects a channel older than the baked-in floor", () => {
    const best = pickBestChannel(
      [
        {
          source: "https://cdn.jsdelivr.net/gh/Slocean/OneLedger@main/app_update.json",
          history: [{ version: "0.4.0", title: "stale", body: "", notice: "" }],
        },
      ],
      "0.4.2",
    );
    expect(best).toBeUndefined();
  });
});
