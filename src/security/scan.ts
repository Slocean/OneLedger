import type { ScanHit, ScanResult, Sensitivity } from "../types.js";

const RULES: Array<{ type: string; level: Sensitivity; re: RegExp }> = [
  { type: "aws_access_key", level: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "github_token", level: "secret", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { type: "openai_key", level: "secret", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { type: "jwt", level: "secret", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: "private_key", level: "secret", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  { type: "connection_string", level: "secret", re: /\b(?:postgres|mysql|mongodb|redis):\/\/[^\s]+:[^\s]+@[^\s]+/gi },
  { type: "env_secret", level: "secret", re: /\b(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\s*[=:]\s*\S+/gi },
  {
    type: "email",
    level: "pii",
    re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
];

const RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  pii: 2,
  secret: 3,
};

export function rank(level: Sensitivity): number {
  return RANK[level];
}

export function higher(a: Sensitivity, b: Sensitivity): Sensitivity {
  return rank(a) >= rank(b) ? a : b;
}

function looksHighEntropy(token: string): boolean {
  if (token.length < 32 || token.length > 128) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false;
  const unique = new Set(token).size;
  return unique >= Math.min(20, token.length * 0.4);
}

export function scanAndRedact(input: string): ScanResult {
  let clean = input;
  const hits: ScanHit[] = [];

  for (const rule of RULES) {
    const matches = input.match(rule.re);
    if (!matches?.length) continue;
    hits.push({ type: rule.type, level: rule.level });
    clean = clean.replace(rule.re, `[REDACTED:${rule.type}]`);
  }

  clean = clean.replace(/\b[A-Za-z0-9+/=_-]{32,128}\b/g, (token) => {
    if (!looksHighEntropy(token)) return token;
    hits.push({ type: "high_entropy", level: "secret" });
    return "[REDACTED:high_entropy]";
  });

  const highest = hits.reduce<Sensitivity>((acc, hit) => higher(acc, hit.level), "public");
  return { cleanText: clean, hits, highest };
}

export function assertSafeForModel(text: string): void {
  const result = scanAndRedact(text);
  if (result.highest === "secret") {
    throw new Error("Refusing to send secret-classified text to a model.");
  }
}
