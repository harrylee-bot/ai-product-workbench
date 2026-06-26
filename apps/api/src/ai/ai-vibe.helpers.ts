import type { Prisma } from "@prisma/client";
import type { QAReport } from "./ai-vibe.types";

export function summarizeText(text: string, maxLength = 2000) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function qaCompletedPayload(qaReport: QAReport) {
  return {
    ...qaReport,
    qaReport,
    qaGate: qaReport.gate,
  };
}
