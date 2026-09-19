import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = "ol"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashToken(token: string): string {
  return sha256(`oneledger.token.v1:${token}`);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function clipTitle(text: string, fallback = "Untitled"): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
