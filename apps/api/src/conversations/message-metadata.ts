import { Prisma } from "@prisma/client";

const DOCUMENT_KINDS = new Set(["text", "code", "image", "sheet", "prototype"]);
const TOOL_STATES = new Set([
  "input-streaming",
  "input-available",
  "output-available",
  "output-error",
]);
const RUNTIME_KINDS = new Set(["status", "knowledge", "tool", "artifact", "document", "error"]);
const RUNTIME_STATUSES = new Set(["running", "completed", "failed"]);
const SAFE_STRING_METADATA_FIELDS = new Map<string, number>([
  ["source", 80],
  ["runId", 240],
  ["handledBy", 120],
  ["status", 80],
  ["prdDocumentId", 240],
  ["prdDocumentTitle", 500],
  ["prototypeArtifactId", 240],
  ["prototypeArtifactTitle", 500],
  ["qaReportId", 240],
  ["qaStatus", 80],
  ["qaBlockingSummary", 1_000],
  ["finalActionType", 80],
  ["threadId", 240],
]);

/**
 * Assistant parts cross a trust boundary: runtime tools may contain prompts,
 * source files, or model reasoning. Persist only parts the chat UI can render.
 */
export function sanitizeAssistantParts(parts: unknown[]): Prisma.InputJsonObject[] {
  if (!Array.isArray(parts)) return [];

  return parts.flatMap((part) => {
    const record = asRecord(part);
    if (!record) return [];

    if (record.type === "text" && typeof record.text === "string") {
      return [{ type: "text", text: record.text } satisfies Prisma.InputJsonObject];
    }

    const documentPart = sanitizeCreateDocumentPart(record);
    return documentPart ? [documentPart] : [];
  });
}

export function sanitizeAssistantMetadataForPersistence(
  metadata: Prisma.InputJsonValue | undefined,
): Prisma.InputJsonValue | undefined {
  if (metadata === undefined) return undefined;
  const record = asRecord(metadata);
  if (!record) return {} as Prisma.InputJsonObject;

  return sanitizeAssistantMetadataRecord(record) as Prisma.InputJsonObject;
}

export function sanitizeAssistantMetadataForOutput(
  metadata: Prisma.JsonValue | null,
): Prisma.JsonValue | null {
  if (metadata === null) return null;
  const record = asRecord(metadata);
  if (!record) return {} as Prisma.JsonObject;

  return sanitizeAssistantMetadataRecord(record) as Prisma.JsonObject;
}

function sanitizeAssistantMetadataRecord(record: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};

  for (const [field, maxLength] of SAFE_STRING_METADATA_FIELDS) {
    const value = boundedString(record[field], maxLength);
    if (value) sanitized[field] = value;
  }
  if (typeof record.draft === "boolean") sanitized.draft = record.draft;

  const runtimeEvents = sanitizeRuntimeEvents(record.runtimeEvents);
  if (runtimeEvents.length > 0) sanitized.runtimeEvents = runtimeEvents;

  if ("parts" in record) {
    const parts = Array.isArray(record.parts)
      ? sanitizeAssistantParts(record.parts)
      : [];
    if (parts.length > 0) sanitized.parts = parts;
    else delete sanitized.parts;
  }

  return sanitized;
}

function sanitizeRuntimeEvents(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-80).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const id = boundedString(record.id, 240);
    const label = boundedString(record.label, 500);
    const createdAt = boundedString(record.createdAt, 80);
    const kind = RUNTIME_KINDS.has(record.kind as string) ? String(record.kind) : undefined;
    const status = RUNTIME_STATUSES.has(record.status as string) ? String(record.status) : undefined;
    if (!id || !label || !createdAt || !kind || !status) return [];

    const event: Record<string, Prisma.InputJsonValue> = {
      id,
      kind,
      label,
      status,
      createdAt,
    };
    const runId = boundedString(record.runId, 240);
    if (runId) event.runId = runId;
    const detail = boundedString(record.detail, 1_000);
    if (detail && !containsInternalRuntimeNoise(detail)) event.detail = detail;
    const artifact = sanitizeDocumentDescriptor(record.artifact, true);
    if (artifact) event.artifact = artifact;
    return [event as Prisma.InputJsonObject];
  });
}

function containsInternalRuntimeNoise(value: string) {
  return /(?:read_file|write_file|write_todos|tool[-_ ]?(?:input|output)|messages-tuple|Context from AI Product Workbench|SKILL\.md|\/mnt\/|\/Users\/|node_modules)/i.test(value);
}

function sanitizeCreateDocumentPart(
  record: Record<string, unknown>,
): Prisma.InputJsonObject | undefined {
  const isTypedDocumentPart = record.type === "tool-createDocument";
  const isDynamicDocumentPart =
    record.type === "dynamic-tool" && record.toolName === "createDocument";
  if (!isTypedDocumentPart && !isDynamicDocumentPart) return undefined;

  const toolCallId = boundedString(record.toolCallId, 240);
  if (!toolCallId) return undefined;

  const input = sanitizeDocumentDescriptor(record.input, false);
  const output = sanitizeDocumentDescriptor(record.output, true);
  const state = TOOL_STATES.has(record.state as string)
    ? (record.state as string)
    : output
      ? "output-available"
      : "input-available";

  const sanitized: Record<string, Prisma.InputJsonValue> = {
    type: isTypedDocumentPart ? "tool-createDocument" : "dynamic-tool",
    toolCallId,
    ...(isDynamicDocumentPart ? { toolName: "createDocument" } : {}),
    state,
  };
  if (input) sanitized.input = input;
  if (output) sanitized.output = output;

  const errorText = boundedString(record.errorText, 500);
  if (state === "output-error" && errorText) sanitized.errorText = errorText;

  return sanitized as Prisma.InputJsonObject;
}

function sanitizeDocumentDescriptor(value: unknown, requireId: boolean) {
  const record = asRecord(value);
  if (!record) return undefined;

  const id = boundedString(record.id, 240);
  if (requireId && !id) return undefined;

  const title = boundedString(record.title, 500);
  const kind = DOCUMENT_KINDS.has(record.kind as string)
    ? (record.kind as string)
    : undefined;
  const descriptor: Record<string, Prisma.InputJsonValue> = {};
  if (id) descriptor.id = id;
  if (title) descriptor.title = title;
  if (kind) descriptor.kind = kind;

  return Object.keys(descriptor).length > 0
    ? (descriptor as Prisma.InputJsonObject)
    : undefined;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
