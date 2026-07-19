import { createHash } from "node:crypto";

const CAPABILITY_NAME = "WORKBENCH_KNOWLEDGE_CAPABILITY";
const TOOL_NAME = "workbench_knowledge_retrieve";
const CAPABILITY_TOKEN = /wbkg1\.[A-Za-z0-9_.-]*/gu;
const MAX_SCAN_NODES = 1_000_000;
const MAX_SCAN_DEPTH = 128;
const MAX_EMBEDDED_JSON_BYTES = 2 * 1024 * 1024;

const REQUIRED_ENVIRONMENT = Object.freeze([
  "DEERFLOW_GATEWAY_URL",
  "DEERFLOW_LANGGRAPH_URL",
  "DEERFLOW_INTERNAL_AUTH_TOKEN",
  "WORKBENCH_DATABASE_URL",
  "WORKBENCH_KNOWLEDGE_TOOL_URL",
  "WORKBENCH_KNOWLEDGE_TOOL_SECRET",
  "WORKBENCH_S3_BUCKET",
  "WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID",
  "WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY",
  "WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_QUERY",
  "WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE",
  "WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION",
]);

export function readKnowledgeSmokeEnvironment(environment) {
  if (environment.NODE_ENV?.trim() !== "production") {
    throw new Error("KNOWLEDGE_SMOKE_NODE_ENV_MUST_BE_PRODUCTION");
  }
  const values = Object.fromEntries(REQUIRED_ENVIRONMENT.map((name) => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`KNOWLEDGE_SMOKE_MISSING_ENV:${name}`);
    return [name, value];
  }));
  const assistantId = environment.DEERFLOW_ASSISTANT_ID?.trim() || "lead_agent";
  if (assistantId !== "lead_agent") {
    throw new Error("KNOWLEDGE_SMOKE_REQUIRES_LEAD_AGENT");
  }
  assertSafeHttpUrl(values.DEERFLOW_GATEWAY_URL, "DEERFLOW_GATEWAY_URL");
  assertSafeHttpUrl(values.DEERFLOW_LANGGRAPH_URL, "DEERFLOW_LANGGRAPH_URL");
  assertSafeHttpUrl(values.WORKBENCH_KNOWLEDGE_TOOL_URL, "WORKBENCH_KNOWLEDGE_TOOL_URL", true);

  const query = boundedText(values.WORKBENCH_KNOWLEDGE_SMOKE_QUERY, 1, 4_000, "QUERY");
  const expectedProbe = boundedText(
    values.WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE,
    12,
    2_000,
    "EXPECTED_PROBE",
  );
  const expectedCitation = boundedText(
    values.WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION,
    1,
    1_024,
    "EXPECTED_CITATION",
  );
  if (query.includes(expectedProbe) || query.includes(expectedCitation)) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_QUERY");
  }

  return Object.freeze({
    runId: values.WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID,
    principalId: values.WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID,
    projectId: values.WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID,
    releaseId: values.WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID,
    query,
    expectedProbe,
    expectedCitation,
    assistantId,
  });
}

export function redactKnowledgeCapability(value) {
  return String(value)
    .replaceAll(CAPABILITY_NAME, "[REDACTED_KNOWLEDGE_CAPABILITY_NAME]")
    .replace(CAPABILITY_TOKEN, "[REDACTED_KNOWLEDGE_CAPABILITY]");
}

export function assertNoKnowledgeCapabilityLeak(surfaces) {
  let scannedNodes = 0;
  for (const surface of surfaces) {
    const label = safeLabel(surface.label);
    walkValue(surface.value, ({ value, key, path }) => {
      scannedNodes += 1;
      if (scannedNodes > MAX_SCAN_NODES) {
        throw new Error("KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED");
      }
      if (typeof key === "string" && isCapabilityLeak(key)) {
        throw new Error(`KNOWLEDGE_SMOKE_CAPABILITY_LEAK:${label}:${redactedPath(path)}`);
      }
      if (typeof value === "string" && isCapabilityLeak(value)) {
        throw new Error(`KNOWLEDGE_SMOKE_CAPABILITY_LEAK:${label}:${redactedPath(path)}`);
      }
    });
  }
  return scannedNodes;
}

export function assertKnowledgeRetrievalProof({
  deerFlowSurfaces,
  ledgerResponses,
  releaseId,
  expectedProbe,
  expectedCitation,
}) {
  const transcript = collectToolTranscript(deerFlowSurfaces);
  if (transcript.declaredCallIds.size === 0 && transcript.namedToolMessages === 0) {
    throw new Error("KNOWLEDGE_SMOKE_TRUSTED_TOOL_CALL_NOT_OBSERVED");
  }
  const deerFlowMatches = matchingRetrievalResults(
    transcript.results,
    releaseId,
    expectedProbe,
    expectedCitation,
  );
  if (deerFlowMatches.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_DEERFLOW_PROBE_NOT_FOUND");
  }
  const ledgerMatches = matchingRetrievalResults(
    ledgerResponses.flatMap(extractRetrievalResults),
    releaseId,
    expectedProbe,
    expectedCitation,
  );
  if (ledgerMatches.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_LEDGER_PROBE_NOT_FOUND");
  }
  const ledgerFingerprints = new Set(ledgerMatches.flatMap((match) => match.fingerprints));
  const sharedFingerprint = deerFlowMatches
    .flatMap((match) => match.fingerprints)
    .find((fingerprint) => ledgerFingerprints.has(fingerprint));
  if (!sharedFingerprint) {
    throw new Error("KNOWLEDGE_SMOKE_DEERFLOW_LEDGER_MISMATCH");
  }
  return Object.freeze({
    declaredToolCalls: transcript.declaredCallIds.size,
    namedToolMessages: transcript.namedToolMessages,
    deerFlowResults: deerFlowMatches.length,
    ledgerResults: ledgerMatches.length,
    citationFingerprint: sharedFingerprint,
  });
}

export function assertFinalOutputContainsEvidence(value, expectedProbe, expectedCitation) {
  let probeFound = false;
  let citationFound = false;
  walkValue(value, ({ value: candidate }) => {
    if (typeof candidate !== "string") return;
    probeFound ||= candidate.includes(expectedProbe);
    citationFound ||= candidate.includes(expectedCitation);
  });
  if (!probeFound) throw new Error("KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_PROBE");
  if (!citationFound) throw new Error("KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_CITATION");
}

export function assertCompleteHistory(history, requestedLimit) {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error("KNOWLEDGE_SMOKE_HISTORY_LIMIT_INVALID");
  }
  if (!Array.isArray(history)) throw new Error("KNOWLEDGE_SMOKE_HISTORY_INVALID");
  if (history.length >= requestedLimit) {
    throw new Error("KNOWLEDGE_SMOKE_STATE_HISTORY_TRUNCATED");
  }
  return history;
}

function collectToolTranscript(surfaces) {
  const declaredCallIds = new Set();
  const toolMessages = [];
  let namedToolMessages = 0;
  for (const surface of surfaces) {
    walkValue(surface, ({ value }) => {
      if (!isRecord(value)) return;
      collectDeclaredCalls(value, declaredCallIds);
      if (!isToolMessage(value)) return;
      const name = messageField(value, "name");
      const callId = messageField(value, "tool_call_id") ?? messageField(value, "toolCallId");
      if (name === TOOL_NAME) namedToolMessages += 1;
      toolMessages.push({
        name,
        callId,
        contents: messageContents(value),
      });
    });
  }
  const results = [];
  for (const message of toolMessages) {
    if (message.name !== TOOL_NAME && (!message.callId || !declaredCallIds.has(message.callId))) continue;
    results.push(...message.contents.flatMap(extractRetrievalResults));
  }
  return { declaredCallIds, namedToolMessages, results };
}

function collectDeclaredCalls(record, callIds) {
  for (const container of [record, nestedRecord(record, "additional_kwargs"), nestedRecord(record, "kwargs"), nestedRecord(record, "lc_kwargs")]) {
    if (!container) continue;
    for (const key of ["tool_calls", "toolCalls"]) {
      const calls = container[key];
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : null;
        const name = stringValue(call.name) ?? stringValue(fn?.name);
        const id = stringValue(call.id) ?? stringValue(call.tool_call_id) ?? stringValue(call.toolCallId);
        if (name === TOOL_NAME && id) callIds.add(id);
      }
    }
  }
}

function isToolMessage(record) {
  const role = messageField(record, "role")?.toLowerCase();
  const type = messageField(record, "type")?.toLowerCase();
  const constructorId = Array.isArray(record.id)
    ? record.id.filter((item) => typeof item === "string").at(-1)?.toLowerCase()
    : undefined;
  return role === "tool" || type === "tool" || type === "toolmessage" || constructorId === "toolmessage";
}

function messageField(record, field) {
  return stringValue(record[field])
    ?? stringValue(nestedRecord(record, "kwargs")?.[field])
    ?? stringValue(nestedRecord(record, "lc_kwargs")?.[field]);
}

function messageContents(record) {
  const values = [
    record.content,
    nestedRecord(record, "kwargs")?.content,
    nestedRecord(record, "lc_kwargs")?.content,
  ].filter((value) => value !== undefined);
  return values.flatMap((value) => {
    if (!Array.isArray(value)) return [value];
    return value.flatMap((part) => {
      if (!isRecord(part)) return [part];
      return [part, part.text, part.content].filter((candidate) => candidate !== undefined);
    });
  });
}

function extractRetrievalResults(value) {
  const candidate = embeddedJson(value);
  if (isRecord(candidate) && candidate.protocol === "workbench.knowledge-retrieval-result.v1") {
    return [candidate];
  }
  return [];
}

function embeddedJson(value) {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value) > MAX_EMBEDDED_JSON_BYTES) return null;
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function matchingRetrievalResults(results, releaseId, expectedProbe, expectedCitation) {
  return results.flatMap((result) => {
    const evidence = isRecord(result.evidence) ? result.evidence : null;
    const release = isRecord(evidence?.release) ? evidence.release : null;
    if (release?.id !== releaseId || !Array.isArray(result.items)) return [];
    const fingerprints = result.items.flatMap((item) => {
      if (!isRecord(item) || !isRecord(item.citation)) return [];
      const citation = item.citation;
      const quote = stringValue(citation.quote);
      const citationValues = [citation.id, citation.sourcePath]
        .filter((value) => typeof value === "string");
      if (!quote?.includes(expectedProbe)) return [];
      if (!citationValues.some((value) => value.includes(expectedCitation))) return [];
      return [citationFingerprint(releaseId, citation)];
    });
    return fingerprints.length > 0 ? [{ result, fingerprints }] : [];
  });
}

function citationFingerprint(releaseId, citation) {
  const canonical = [releaseId, citation.id, citation.documentId, citation.chunkId, citation.sourcePath, citation.quote]
    .map((value) => String(value ?? ""))
    .join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

function walkValue(root, visitor) {
  const seen = new WeakSet();
  const stack = [{ value: root, key: null, path: "$", depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    visitor(current);
    if (current.depth >= MAX_SCAN_DEPTH) {
      if (current.value !== null && typeof current.value === "object") {
        throw new Error("KNOWLEDGE_SMOKE_SCAN_DEPTH_EXCEEDED");
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    const entries = Array.isArray(current.value)
      ? current.value.map((value, index) => [String(index), value])
      : Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index];
      stack.push({
        value,
        key,
        path: `${current.path}.${safePathSegment(key)}`,
        depth: current.depth + 1,
      });
    }
  }
}

function isCapabilityLeak(value) {
  return value.includes(CAPABILITY_NAME) || value.includes("wbkg1.");
}

function nestedRecord(record, key) {
  return isRecord(record[key]) ? record[key] : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

function assertSafeHttpUrl(value, name, requireHttps = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_URL:${name}`);
  }
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (requireHttps && url.protocol !== "https:")
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_URL:${name}`);
  }
}

function boundedText(value, minimum, maximum, label) {
  if (value.length < minimum || value.length > maximum || value.includes("\u0000")) {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  }
  return value.normalize("NFC");
}

function safeLabel(value) {
  const label = String(value);
  return /^[A-Za-z0-9_.-]{1,80}$/u.test(label) ? label : "surface";
}

function safePathSegment(value) {
  if (isCapabilityLeak(value)) return "[redacted-key]";
  return /^[A-Za-z0-9_-]{1,80}$/u.test(value) ? value : "[field]";
}

function redactedPath(value) {
  return redactKnowledgeCapability(value).slice(0, 512);
}

export const knowledgeSmokeConstants = Object.freeze({
  capabilityName: CAPABILITY_NAME,
  toolName: TOOL_NAME,
});
