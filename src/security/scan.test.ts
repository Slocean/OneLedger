import { describe, expect, it } from "vitest";
import { scanAndRedact, verifyRedacted } from "./scan.js";

/** 两端共享的回归样本：同一份样本在 Rust 与 TypeScript 必须给出一致状态。
 *  样本不含真实凭据。 */
const SAMPLES: Array<[string, boolean]> = [
  ["配置里写了 token sk-abcdefghijklmnopqrstuvwxyz123456 也要保留说明。", true],
  ["说明\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\n结尾", true],
  ["残留\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0", true],
  ["TOKEN=0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c", true],
  ["SECRET = 0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c", true],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", true],
  ["postgres://admin:s3cr3tpass@db.internal:5432/app", true],
  ["配置如下\nOPENAI_API_KEY = sk-abcdefghijklmnopqrstuvwxyz123456\nDATABASE_URL=postgres://u:p4ssw0rd@host:5432/db\n结束", true],
  ["equipment/v2/production/storeList f81d4fae-7dec-11d0-a765-00a0c91e6bf6", false],
  [String.raw`项目路径 D:\PROJECT\CofoeAirLink_Web\src\equipment\v2\storeList.ts`, false],
  ["内容指纹 a6778de21a25c0888b933c8ffb230062d28b6448e40c1747629c290fa171bbf6", false],
  ["采集器只读取约定文件，蒸馏后形成连贯的项目记忆。", false],
];

describe("scanAndRedact", () => {
  it("removes the rest of an incomplete private key block", () => {
    const result = scanAndRedact("keep\n-----BEGIN PRIVATE KEY-----\nraw-secret-lines");
    expect(result.cleanText).toContain("keep");
    expect(result.cleanText).not.toContain("raw-secret-lines");
    expect(result.hits.some((hit) => hit.type === "private_key_incomplete")).toBe(true);
  });
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

  it("does not flag URL paths or kebab-case file names as secrets", () => {
    const result = scanAndRedact(
      "门店下拉用 GET /equipment/v2/production/storeList，打印模板在 build-report-export-template-html.ts。",
    );
    expect(result.highest).toBe("public");
    expect(result.cleanText).toContain("equipment/v2/production/storeList");
    expect(result.cleanText).toContain("build-report-export-template-html");
  });

  it("does not flag UUIDs", () => {
    const result = scanAndRedact("session f81d4fae-7dec-11d0-a765-00a0c91e6bf6 expired.");
    expect(result.highest).toBe("public");
  });

  it("still redacts high-entropy credential-like tokens", () => {
    const result = scanAndRedact("key ol_a788a2f0d51a4926488487f28eb0356b rotated");
    expect(result.highest).toBe("secret");
    expect(result.cleanText).toContain("[REDACTED:high_entropy]");
  });

  it("matches the shared cross-runtime sample set", () => {
    for (const [sample, expectsSecret] of SAMPLES) {
      const result = scanAndRedact(sample);
      expect(result.highest === "secret", `sample 的敏感级别不符合预期：${sample}`).toBe(expectsSecret);
      expect(verifyRedacted(result.cleanText), `替换后仍有残留：${sample}`).toEqual([]);
    }
  });

  it("reports residue when a credential survived the first pass", () => {
    const residue = "说明\n-----BEGIN PRIVATE KEY-----\n仍然存在的密钥材料";
    const hits = verifyRedacted(residue);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.type === "private_key_incomplete")).toBe(true);
  });

  it("never lets redaction markers trigger the second pass", () => {
    for (const marker of [
      "[REDACTED:private_key]",
      "[REDACTED:high_entropy]",
      "[REDACTED:env_secret]",
      "[REDACTED:openai_key]",
      "[REDACTED:private_key_incomplete]",
    ]) {
      expect(verifyRedacted(marker), `标记被误判：${marker}`).toEqual([]);
    }
  });
});
