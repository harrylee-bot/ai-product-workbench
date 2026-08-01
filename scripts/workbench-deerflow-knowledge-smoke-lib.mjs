import { createHash } from "node:crypto";

const CAPABILITY_NAME = "WORKBENCH_KNOWLEDGE_CAPABILITY";
const TOOL_NAME = "workbench_knowledge_retrieve";
const CAPABILITY_TOKEN = /wbkg1\.[A-Za-z0-9_.-]*/gu;
const MAX_SCAN_NODES = 1_000_000;
const MAX_SCAN_DEPTH = 128;
const MAX_EMBEDDED_JSON_BYTES = 2 * 1024 * 1024;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;

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
  "WORKBENCH_SOURCE_COMMIT",
  "WORKBENCH_RUNTIME_WORKER_IMAGE_REF",
  "WORKBENCH_DEERFLOW_IMAGE_REF",
  "WORKBENCH_DEERFLOW_IMAGE_DIGEST",
  "WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_QUERY",
  "WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE",
  "WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_PRINCIPAL_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_PROJECT_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_QUERY",
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

  const candidateCommit = exactPattern(
    values.WORKBENCH_SOURCE_COMMIT,
    COMMIT_SHA,
    "SOURCE_COMMIT",
  );
  const runtimeWorkerImageDigest = imageDigestFromRef(
    values.WORKBENCH_RUNTIME_WORKER_IMAGE_REF,
    "RUNTIME_WORKER_IMAGE_REF",
  );
  const deerFlowImageDigest = imageDigestFromRef(
    values.WORKBENCH_DEERFLOW_IMAGE_REF,
    "DEERFLOW_IMAGE_REF",
  );
  if (deerFlowImageDigest !== values.WORKBENCH_DEERFLOW_IMAGE_DIGEST) {
    throw new Error("KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_DIGEST_MISMATCH");
  }

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
  const nullQuery = boundedText(values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_QUERY, 1, 4_000, "NULL_QUERY");
  if (nullQuery.includes(expectedProbe) || nullQuery.includes(expectedCitation)) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_NULL_QUERY");
  }
  if (values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID === values.WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_RUNS_MUST_DIFFER");
  }

  return Object.freeze({
    binding: Object.freeze({
      candidateCommit,
      runtimeWorkerImageDigest,
      deerFlowImageDigest,
    }),
    valid: Object.freeze({
      runId: values.WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID,
      principalId: values.WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID,
      projectId: values.WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID,
      releaseId: values.WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID,
      query,
    }),
    nullRelease: Object.freeze({
      runId: values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID,
      principalId: values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_PRINCIPAL_ID,
      projectId: values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_PROJECT_ID,
      releaseId: null,
      query: nullQuery,
    }),
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

export function assertKnowledgeCatalogHidden(deerFlowSurfaces) {
  const transcript = collectToolTranscript(deerFlowSurfaces);
  if (
    transcript.declaredCallIds.size > 0
    || transcript.namedToolMessages > 0
    || transcript.results.length > 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN");
  }
  let capabilityMissingObserved = false;
  for (const surface of deerFlowSurfaces) {
    walkValue(surface, ({ value }) => {
      capabilityMissingObserved ||= typeof value === "string"
        && value.includes("WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING");
    });
  }
  if (capabilityMissingObserved) {
    throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_REACHED_CAPABILITY_DEFENSE");
  }
  return Object.freeze({
    declaredToolCalls: 0,
    namedToolMessages: 0,
    retrievalResults: 0,
    capabilityMissingObserved: false,
  });
}

export function assertKnowledgeEvidenceAbsent(surfaces, expectedProbe, expectedCitation) {
  let leaked = false;
  for (const surface of surfaces) {
    walkValue(surface, ({ value }) => {
      leaked ||= typeof value === "string"
        && (value.includes(expectedProbe) || value.includes(expectedCitation));
    });
  }
  if (leaked) throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_RETRIEVAL_EVIDENCE_LEAK");
  return true;
}

export function assertConcurrentOppositeScope({ valid, nullRelease }) {
  if (
    !valid
    || !nullRelease
    || valid.runId === nullRelease.runId
    || valid.runtimeAttemptId === nullRelease.runtimeAttemptId
    || valid.externalThreadId === nullRelease.externalThreadId
    || valid.externalRunId === nullRelease.externalRunId
    || valid.releaseId === null
    || nullRelease.releaseId !== null
    || valid.grantCount !== 1
    || valid.successfulInvocationCount < 1
    || valid.invocationCount < valid.successfulInvocationCount
    || nullRelease.grantCount !== 0
    || nullRelease.invocationCount !== 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_ISOLATION_FAILED");
  }
  const validStartedAt = dateMillis(valid.startedAt);
  const validFinishedAt = dateMillis(valid.finishedAt);
  const nullStartedAt = dateMillis(nullRelease.startedAt);
  const nullFinishedAt = dateMillis(nullRelease.finishedAt);
  if (Math.max(validStartedAt, nullStartedAt) > Math.min(validFinishedAt, nullFinishedAt)) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_DID_NOT_OVERLAP");
  }
  return Object.freeze({
    concurrentExecutionObserved: true,
    distinctRuntimeScopes: true,
    validScopeEndpointCalls: valid.invocationCount,
    nullScopeEndpointCalls: 0,
  });
}

export function buildKnowledgeSmokeEvidence({
  binding,
  valid,
  nullRelease,
  isolation,
  forbiddenValues,
}) {
  if (
    valid.successfulInvocationCount < 1
    || valid.proof?.declaredToolCalls < 1
    || nullRelease.grantCount !== 0
    || nullRelease.endpointCalls !== 0
    || nullRelease.catalog?.declaredToolCalls !== 0
    || nullRelease.catalog?.namedToolMessages !== 0
    || nullRelease.catalog?.retrievalResults !== 0
    || nullRelease.catalog?.capabilityMissingObserved !== false
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_INCOMPLETE");
  }
  const evidence = {
    schema: "workbench.deerflow-knowledge-deployed-evidence.v2",
    result: "PASS",
    binding: {
      candidateCommit: binding.candidateCommit,
      runtimeWorkerImageDigest: binding.runtimeWorkerImageDigest,
      deerFlowImageDigest: binding.deerFlowImageDigest,
    },
    validPinnedRelease: {
      scopeFingerprint: evidenceFingerprint("valid-scope", valid.scopeIds),
      releaseFingerprint: evidenceFingerprint("knowledge-release", [valid.releaseId]),
      catalogVisible: valid.proof.declaredToolCalls > 0,
      invocationPassed: true,
      successfulEndpointCalls: valid.successfulInvocationCount,
      checkpointStatesScanned: valid.checkpointStatesScanned,
      structuredValuesScanned: valid.structuredValuesScanned,
      proof: valid.proof,
    },
    nullRelease: {
      scopeFingerprint: evidenceFingerprint("null-scope", nullRelease.scopeIds),
      releasePinned: false,
      grantCount: nullRelease.grantCount,
      endpointCalls: nullRelease.endpointCalls,
      catalogHidden: true,
      capabilityMissingObserved: nullRelease.catalog.capabilityMissingObserved,
      checkpointStatesScanned: nullRelease.checkpointStatesScanned,
      structuredValuesScanned: nullRelease.structuredValuesScanned,
    },
    concurrentOppositeScope: isolation,
    secretsNotPersisted: true,
  };
  assertRedactedKnowledgeEvidence(evidence, forbiddenValues);
  return Object.freeze(evidence);
}

export function assertRedactedKnowledgeEvidence(evidence, forbiddenValues = []) {
  const serialized = JSON.stringify(evidence);
  if (isCapabilityLeak(serialized)) {
    throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_CAPABILITY_LEAK");
  }
  for (const forbidden of forbiddenValues) {
    if (typeof forbidden === "string" && forbidden.length > 0 && serialized.includes(forbidden)) {
      throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_RAW_VALUE_LEAK");
    }
  }
  return evidence;
}

export function safeKnowledgeSmokeError(error) {
  const message = redactKnowledgeCapability(error instanceof Error ? error.message : String(error));
  const match = /^([A-Z][A-Z0-9_]{2,})(?::([0-9]{3}|[A-Z][A-Z0-9_]{2,}))?$/u.exec(message);
  const safePrefix = match?.[1].startsWith("KNOWLEDGE_SMOKE_")
    || match?.[1].startsWith("DEERFLOW_");
  return match && safePrefix ? match[0] : "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE";
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

function evidenceFingerprint(domain, values) {
  const canonical = [domain, ...values].map((value) => String(value ?? "")).join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

function dateMillis(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw new Error("KNOWLEDGE_SMOKE_INVALID_EXECUTION_WINDOW");
  return milliseconds;
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

function exactPattern(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  return value;
}

function imageDigestFromRef(value, label) {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  return exactPattern(value.slice(separator + 1), IMAGE_DIGEST, label);
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
