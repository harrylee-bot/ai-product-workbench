export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export type ParsedMarkdownFrontmatter = {
  attributes: Record<string, FrontmatterValue>;
  body: string;
  hasFrontmatter: boolean;
};

export type VaultDocumentStatus = "active" | "draft" | "disabled" | "archived";

/**
 * Parses the flat YAML subset used by the vault contract. Unsupported nesting and
 * malformed values fail closed so a damaged header cannot silently publish content.
 */
export function parseMarkdownFrontmatter(
  raw: string,
  sourceName = "Markdown document",
): ParsedMarkdownFrontmatter {
  const normalized = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized.trim(), hasFrontmatter: false };
  }

  const closingOffset = findClosingDelimiter(normalized);
  if (closingOffset < 0) {
    throw new Error(`${sourceName} frontmatter is missing a closing delimiter`);
  }

  const header = normalized.slice(4, closingOffset);
  const delimiterEnd = normalized.indexOf("\n", closingOffset) + 1;
  const body = normalized.slice(delimiterEnd || normalized.length).trim();
  return {
    attributes: parseFlatYaml(header, sourceName),
    body,
    hasFrontmatter: true,
  };
}

export function frontmatterString(
  attributes: Record<string, FrontmatterValue>,
  ...keys: string[]
): string | undefined {
  const value = firstValue(attributes, keys);
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function frontmatterStringArray(
  attributes: Record<string, FrontmatterValue>,
  ...keys: string[]
): string[] {
  const value = firstValue(attributes, keys);
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values
    .map((item) => String(item).trim())
    .filter(Boolean);
}

export function resolveVaultDocumentStatus(
  attributes: Record<string, FrontmatterValue>,
): VaultDocumentStatus {
  const draft = firstValue(attributes, ["draft"]);
  if (draft !== undefined) {
    const parsedDraft = coerceBoolean(draft);
    if (parsedDraft === undefined) throw new Error("frontmatter draft must be a boolean");
    if (parsedDraft) return "draft";
  }

  const rawStatus = firstValue(attributes, ["status", "状态"]);
  if (Array.isArray(rawStatus)) throw new Error("frontmatter status must be a scalar");
  const status = frontmatterString(attributes, "status", "状态")?.toLowerCase().trim();
  if (!status) return "active";
  if (/^(?:draft|草稿|待审核|待发布|未发布|待整理)$/.test(status)) return "draft";
  if (/^(?:disabled|inactive|停用|已停用|禁用|已禁用|不参与检索)$/.test(status)) return "disabled";
  if (/^(?:archived|archive|归档|已归档)$/.test(status)) return "archived";
  return "active";
}

export function isActiveVaultDocument(attributes: Record<string, FrontmatterValue>) {
  return resolveVaultDocumentStatus(attributes) === "active";
}

function findClosingDelimiter(raw: string) {
  const match = /\n(?:---|\.\.\.)(?:\n|$)/g.exec(raw.slice(3));
  return match ? match.index + 4 : -1;
}

function parseFlatYaml(header: string, sourceName: string) {
  const attributes: Record<string, FrontmatterValue> = {};
  const lines = header.split("\n");
  let currentArrayKey: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 2;
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const listItem = rawLine.match(/^\s+-\s+(.+)$/);
    if (listItem) {
      if (!currentArrayKey) {
        throw new Error(`${sourceName} frontmatter line ${lineNumber} has an orphan list item`);
      }
      const current = attributes[currentArrayKey];
      if (!Array.isArray(current)) {
        throw new Error(`${sourceName} frontmatter key ${currentArrayKey} is not a list`);
      }
      current.push(parseScalar(listItem[1], sourceName, lineNumber));
      continue;
    }

    if (/^\s+/.test(rawLine)) {
      throw new Error(`${sourceName} frontmatter line ${lineNumber} uses unsupported nested YAML`);
    }

    const property = rawLine.match(/^([\p{L}\p{N}_-]+):(?:\s*(.*))?$/u);
    if (!property) {
      throw new Error(`${sourceName} frontmatter line ${lineNumber} is not a valid property`);
    }
    const key = property[1];
    if (Object.hasOwn(attributes, key)) {
      throw new Error(`${sourceName} frontmatter contains duplicate key ${key}`);
    }

    const rawValue = stripYamlComment(property[2]?.trim() ?? "").trim();
    if (!rawValue) {
      attributes[key] = [];
      currentArrayKey = key;
      continue;
    }

    attributes[key] = rawValue.startsWith("[")
      ? parseInlineArray(rawValue, sourceName, lineNumber)
      : parseScalar(rawValue, sourceName, lineNumber);
    currentArrayKey = undefined;
  }

  return attributes;
}

function parseInlineArray(raw: string, sourceName: string, lineNumber: number) {
  if (!raw.endsWith("]")) {
    throw new Error(`${sourceName} frontmatter line ${lineNumber} has an unterminated list`);
  }
  const body = raw.slice(1, -1).trim();
  if (!body) return [];

  const values: FrontmatterScalar[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      current += character;
      if (character === quote && (quote === "'" || body[index - 1] !== "\\")) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      values.push(parseScalar(current.trim(), sourceName, lineNumber));
      current = "";
      continue;
    }
    current += character;
  }
  if (quote) throw new Error(`${sourceName} frontmatter line ${lineNumber} has an unterminated quote`);
  values.push(parseScalar(current.trim(), sourceName, lineNumber));
  return values;
}

function parseScalar(raw: string, sourceName: string, lineNumber: number): FrontmatterScalar {
  const value = stripYamlComment(raw).trim();
  if (!value) return "";
  if (value.startsWith("\"") || value.startsWith("'")) {
    return parseQuotedScalar(value, sourceName, lineNumber);
  }
  if (/[\[\]{}]/.test(value)) {
    throw new Error(`${sourceName} frontmatter line ${lineNumber} uses unsupported YAML syntax`);
  }
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^(?:null|~)$/i.test(value)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseQuotedScalar(raw: string, sourceName: string, lineNumber: number) {
  const quote = raw[0];
  if (raw.at(-1) !== quote) {
    throw new Error(`${sourceName} frontmatter line ${lineNumber} has an unterminated quote`);
  }
  if (quote === "'") return raw.slice(1, -1).replaceAll("''", "'");
  try {
    return JSON.parse(raw) as string;
  } catch {
    throw new Error(`${sourceName} frontmatter line ${lineNumber} has an invalid quoted value`);
  }
}

function stripYamlComment(raw: string) {
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === quote && (quote === "'" || raw[index - 1] !== "\\")) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(raw[index - 1]))) return raw.slice(0, index);
  }
  return raw;
}

function firstValue(attributes: Record<string, FrontmatterValue>, keys: string[]) {
  for (const key of keys) {
    if (Object.hasOwn(attributes, key)) return attributes[key];
  }
  return undefined;
}

function coerceBoolean(value: FrontmatterValue) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== "string") return undefined;
  if (/^(?:true|yes|1|是)$/i.test(value.trim())) return true;
  if (/^(?:false|no|0|否)$/i.test(value.trim())) return false;
  return undefined;
}
