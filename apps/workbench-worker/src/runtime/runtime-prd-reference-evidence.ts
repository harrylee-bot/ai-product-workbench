import { createHash } from "node:crypto";
import { posix } from "node:path";

const READ_FILE_TOOL = "read_file";
const PRD_REFERENCE_ROOT = "/mnt/skills/public";

export const PRD_RUNTIME_REFERENCE_FILES = [
  {
    relativePath: "requirement-doc-template/SKILL.md",
    sha256: "fe1493653986206aeed4684b46235c41d58e1e49db2b143ec0be5840542446e0",
  },
  {
    relativePath: "requirement-doc-template/references/structure.md",
    sha256: "7952eb98fadbbd992f1bdbd227953aacbcbcdea7fdef1f758987750a9ac5bf70",
  },
  {
    relativePath: "requirement-doc-template/references/quality-standards.md",
    sha256: "32dc990927fbaf126e2d79f291869df8e576454261d4a644e916f3020c70d44e",
  },
  {
    relativePath: "workbench/references/prd-runtime-result.schema.json",
    sha256: "52c29a5477e5a854bedf807ba947dca21b6f62d1a841c0f5aea3e1b55dddcd65",
  },
] as const;

export type PrdReferenceEvidenceBoundaries = {
  collectingResponseIndex: number;
  structuringDeclarationIndex: number;
  draftingDeclarationIndex: number;
  artifactDeclarationIndex: number;
};

type ReferenceCall = {
  toolCallId: string;
  declarationIndex: number;
  declarationOrder: number;
  reference: (typeof PRD_RUNTIME_REFERENCE_FILES)[number];
  exactPath: boolean;
  ranged: boolean;
};

type ReferenceResponse = {
  message: Record<string, unknown>;
  messageIndex: number;
};

export function assertPrdReferenceReadEvidence(
  state: unknown,
  boundaries: PrdReferenceEvidenceBoundaries,
) {
  const messages = runtimeMessages(state);
  const currentTurnStart = currentTurnStartIndex(messages);
  if (currentTurnStart < 0) {
    throw new Error("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_MISSING");
  }

  const calls: ReferenceCall[] = [];
  for (let index = currentTurnStart + 1; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message || !isAssistant(message)) continue;
    for (const call of messageToolCalls(message)) {
      if (call.name !== READ_FILE_TOOL || !call.path) continue;
      const normalizedPath = posix.normalize(call.path);
      const reference = PRD_RUNTIME_REFERENCE_FILES.find((candidate) => (
        normalizedPath === candidate.relativePath
        || normalizedPath.endsWith(`/${candidate.relativePath}`)
      ));
      if (!reference) continue;
      calls.push({
        toolCallId: call.id,
        declarationIndex: index,
        declarationOrder: calls.length,
        reference,
        exactPath: call.path === `${PRD_REFERENCE_ROOT}/${reference.relativePath}`,
        ranged: call.ranged,
      });
    }
  }

  const canonicalVerifiedReads: Array<{ call: ReferenceCall; response: ReferenceResponse }> = [];
  for (const reference of PRD_RUNTIME_REFERENCE_FILES) {
    const matchingCalls = calls.filter((call) => call.reference.relativePath === reference.relativePath);
    if (matchingCalls.length === 0) {
      throw new Error("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_MISSING");
    }
    const diagnostics: string[] = [];
    const verifiedReads: Array<{ call: ReferenceCall; response: ReferenceResponse }> = [];
    for (const call of matchingCalls) {
      if (!call.exactPath) {
        diagnostics.push("RUNTIME_ARTIFACT_PRD_REFERENCE_PATH_INVALID");
        continue;
      }
      if (call.ranged) {
        diagnostics.push("RUNTIME_ARTIFACT_PRD_REFERENCE_RANGE_INVALID");
        continue;
      }
      const responses = matchingToolResponses(messages, currentTurnStart, call.toolCallId);
      if (responses.length === 0) {
        diagnostics.push("RUNTIME_ARTIFACT_PRD_REFERENCE_TOOL_MESSAGE_MISSING");
        continue;
      }
      if (responses.length !== 1) {
        diagnostics.push("RUNTIME_ARTIFACT_PRD_REFERENCE_TOOL_MESSAGE_MULTIPLE");
        continue;
      }

      const response = responses[0]!;
      const status = messageField(response.message, "status")?.toLowerCase();
      const content = toolMessageContent(messageValue(response.message, "content"));
      if (
        (status !== undefined && status !== "success")
        || content === null
        || content.trimStart().startsWith("Error:")
      ) {
        diagnostics.push("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_FAILED");
        continue;
      }
      if (sha256(content) !== reference.sha256) {
        diagnostics.push("RUNTIME_ARTIFACT_PRD_REFERENCE_CONTENT_INVALID");
        continue;
      }
      verifiedReads.push({ call, response });
    }

    if (verifiedReads.length === 0) {
      throw new Error(diagnostics.at(-1) ?? "RUNTIME_ARTIFACT_PRD_REFERENCE_READ_MISSING");
    }
    if (verifiedReads.length !== 1) {
      throw new Error("RUNTIME_ARTIFACT_PRD_REFERENCE_READ_DUPLICATE");
    }
    const verified = verifiedReads[0]!;
    if (
      verified.call.declarationIndex <= boundaries.collectingResponseIndex
      || verified.response.messageIndex <= verified.call.declarationIndex
      || verified.response.messageIndex >= boundaries.structuringDeclarationIndex
      || verified.response.messageIndex >= boundaries.draftingDeclarationIndex
      || verified.response.messageIndex >= boundaries.artifactDeclarationIndex
    ) {
      throw new Error("RUNTIME_ARTIFACT_PRD_REFERENCE_ORDER_INVALID");
    }
    canonicalVerifiedReads.push(verified);
  }

  for (let index = 1; index < canonicalVerifiedReads.length; index += 1) {
    const previous = canonicalVerifiedReads[index - 1]!;
    const current = canonicalVerifiedReads[index]!;
    if (
      current.call.declarationOrder <= previous.call.declarationOrder
      || current.response.messageIndex <= previous.response.messageIndex
    ) {
      throw new Error("RUNTIME_ARTIFACT_PRD_REFERENCE_ORDER_INVALID");
    }
  }
}

function matchingToolResponses(
  messages: unknown[],
  currentTurnStart: number,
  toolCallId: string,
): ReferenceResponse[] {
  const responses: ReferenceResponse[] = [];
  for (let index = currentTurnStart + 1; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message || !isTool(message)) continue;
    if (messageField(message, "tool_call_id") !== toolCallId) continue;
    const name = messageField(message, "name");
    if (name !== undefined && name !== READ_FILE_TOOL) continue;
    responses.push({ message, messageIndex: index });
  }
  return responses;
}

function messageToolCalls(message: Record<string, unknown>) {
  const additionalKwargs = asRecord(messageValue(message, "additional_kwargs"));
  const rawCalls = messageValue(message, "tool_calls") ?? additionalKwargs?.tool_calls;
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.flatMap((rawCall) => {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const id = stringValue(call?.id);
    const name = stringValue(call?.name) ?? stringValue(fn?.name);
    const args = toolCallArguments(call?.args ?? call?.arguments ?? fn?.arguments);
    const path = args
      ? stringValue(args.path) ?? stringValue(args.file_path) ?? stringValue(args.filepath)
      : undefined;
    const ranged = args
      ? args.start_line !== undefined && args.start_line !== null
        || args.end_line !== undefined && args.end_line !== null
      : false;
    return id && name ? [{ id, name, path, ranged }] : [];
  });
}

function toolCallArguments(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function toolMessageContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const part = asRecord(item);
    const text = stringValue(part?.text) ?? stringValue(part?.content);
    if (!text) return null;
    parts.push(text);
  }
  return parts.join("");
}

function runtimeMessages(stateValue: unknown) {
  const state = asRecord(stateValue);
  const nested = asRecord(state?.values);
  if (Array.isArray(state?.messages)) return state.messages;
  return Array.isArray(nested?.messages) ? nested.messages : [];
}

function currentTurnStartIndex(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message && isHuman(message)) return index;
  }
  return -1;
}

function isAssistant(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  const constructor = messageConstructor(message);
  if (asRecord(messageValue(message, "additional_kwargs"))?.hide_from_ui === true) return false;
  return role === "assistant" || role === "ai" || [
    "ai",
    "assistant",
    "aimessage",
    "aimessagechunk",
  ].includes(type ?? "") || constructor === "aimessage" || constructor === "aimessagechunk";
}

function isHuman(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  const constructor = messageConstructor(message);
  return role === "user"
    || role === "human"
    || ["human", "user", "humanmessage", "usermessage"].includes(type ?? "")
    || constructor === "humanmessage";
}

function isTool(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  return role === "tool"
    || type === "tool"
    || type === "toolmessage"
    || messageConstructor(message) === "toolmessage";
}

function messageConstructor(message: Record<string, unknown>) {
  return Array.isArray(message.id)
    ? message.id.filter((item): item is string => typeof item === "string").at(-1)?.toLowerCase()
    : undefined;
}

function messageField(message: Record<string, unknown>, field: string) {
  return stringValue(messageValue(message, field));
}

function messageValue(message: Record<string, unknown>, field: string) {
  for (const container of [message, asRecord(message.kwargs), asRecord(message.lc_kwargs)]) {
    if (container && container[field] !== undefined) return container[field];
  }
  return undefined;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
