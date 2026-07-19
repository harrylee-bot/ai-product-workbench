import { parseDocument } from "yaml";

import { isAcceptedKnowledgeStatus } from "./routing.js";
import type { JsonValue, KnowledgeFrontmatter, KnowledgeIssue } from "./types.js";

export interface FrontmatterResult {
  readonly value?: KnowledgeFrontmatter;
  readonly issues: readonly Omit<KnowledgeIssue, "sourceLocator">[];
}

export function parseKnowledgeFrontmatter(raw: string | undefined): FrontmatterResult {
  if (raw === undefined) {
    return {
      issues: [{
        code: "FRONTMATTER_MISSING",
        severity: "error",
        message: "Markdown document must begin with YAML frontmatter",
      }],
    };
  }

  let parsed: unknown;
  try {
    const document = parseDocument(raw, {
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      return {
        issues: [{
          code: "FRONTMATTER_YAML_INVALID",
          severity: "error",
          message: document.errors.map((error) => error.code).sort().join(", ") || "YAML_PARSE_ERROR",
        }],
      };
    }
    parsed = document.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return {
      issues: [{
        code: "FRONTMATTER_YAML_INVALID",
        severity: "error",
        message: error instanceof Error ? error.message : "YAML_PARSE_ERROR",
      }],
    };
  }

  if (!isRecord(parsed)) return invalid("frontmatter must be a mapping");
  const title = requiredString(parsed.title);
  const status = requiredString(parsed.status);
  const tags = stringArray(parsed.tags);
  const aliases = parsed.aliases === undefined ? [] : stringArray(parsed.aliases);
  if (!title || !status || !tags || !aliases) {
    return invalid("frontmatter requires non-empty title/status and string arrays for tags/aliases");
  }

  const description = optionalString(parsed.description);
  const date = optionalString(parsed.date);
  const source = optionalString(parsed.source);
  if (description === null || date === null || source === null) {
    return invalid("description/date/source must be strings when present");
  }

  const extra: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (["title", "description", "date", "status", "tags", "aliases", "source"].includes(key)) continue;
    const json = toJsonValue(value);
    if (json === undefined) return invalid(`frontmatter field ${key} is not JSON-compatible`);
    extra[key] = json;
  }

  const issues: Array<Omit<KnowledgeIssue, "sourceLocator">> = [];
  if (!isAcceptedKnowledgeStatus(status)) {
    issues.push({
      code: "FRONTMATTER_STATUS_UNKNOWN",
      severity: "error",
      message: `unsupported knowledge status: ${status}`,
    });
  }

  return {
    value: {
      title,
      ...(description ? { description } : {}),
      ...(date ? { date } : {}),
      status,
      tags,
      aliases,
      ...(source ? { source } : {}),
      extra,
    },
    issues,
  };
}

function invalid(message: string): FrontmatterResult {
  return {
    issues: [{ code: "FRONTMATTER_INVALID", severity: "error", message }],
  };
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().normalize("NFC") : undefined;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim().normalize("NFC");
  return normalized || undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  const normalized = value
    .map((item) => item.trim().normalize("NFC"))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values = value.map(toJsonValue);
    return values.some((item) => item === undefined) ? undefined : values as JsonValue[];
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = toJsonValue(child);
      if (normalized === undefined) return undefined;
      result[key] = normalized;
    }
    return result;
  }
  return undefined;
}
