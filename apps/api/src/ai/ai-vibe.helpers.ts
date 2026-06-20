import type { Prisma } from "@prisma/client";

export function summarizeText(text: string, maxLength = 2000) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function firstSentence(value: string, fallback: string) {
  const sentence = value
    .split(/[。！？!?]/)
    .map((item) => item.trim())
    .find(Boolean);
  return sentence ?? fallback;
}

export function stableId(prefix: string, input: string) {
  const suffix = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return suffix ? `${prefix}_${suffix}` : `${prefix}_${Date.now().toString(36)}`;
}
