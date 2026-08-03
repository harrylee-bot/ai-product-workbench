#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PgBoss } from "pg-boss";
import {
  createAndAssertRuntimeQueues,
  runtimeExecuteQueue,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
import {
  assertDeploymentBinding,
  assertCompleteHistory,
  assertConcurrentOppositeScope,
  assertExternalRunBinding,
  assertFinalOutputContainsEvidence,
  assertHistoryBoundToExternalRun,
  assertKnowledgeGrantScope,
  assertKnowledgeCatalogHidden,
  assertKnowledgeEvidenceAbsent,
  assertKnowledgeRetrievalProof,
  assertNoKnowledgeCapabilityLeak,
  assertRuntimeAttemptIdentityBinding,
  assertRuntimeWorkerExecutionTrustPolicy,
  assertRuntimeWorkerExecutionBinding,
  buildKnowledgeSmokeEvidence,
  collectKnownSmokeSecrets,
  readKnowledgeSmokeEnvironment,
  runtimeExecuteSmokeJob,
  safeKnowledgeSmokeError,
} from "./workbench-deerflow-knowledge-smoke-lib.mjs";
import { loadProductionTrustPolicy } from "./workbench-production-trust-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The pinned DeerFlow history endpoint rejects limits above 100. Reaching the
// maximum remains fail-closed because the response may be truncated.
const HISTORY_LIMIT = 100;
// Pinned DeerFlow ignores the SDK's run-list pagination parameters and returns
// at most 100 records. Treat that boundary as incomplete instead of replaying
// the same first page under different offsets.
const RUN_LIST_LIMIT = 100;
const RUNTIME_ATTEMPT_RECEIPT_SELECT = Object.freeze({
  id: true,
  runId: true,
  runtimeBindingId: true,
  attempt: true,
  adapter: true,
  providerIdempotencyKey: true,
  externalThreadId: true,
  externalRunId: true,
  status: true,
  runtimeBinding: {
      select: {
        id: true,
        threadId: true,
        adapter: true,
        externalThreadId: true,
        metadata: true,
      },
  },
});
const execFileAsync = promisify(execFile);
let database = null;
let queue = null;

try {
  await main();
} catch (error) {
  process.stderr.write(`[knowledge-smoke] ${safeKnowledgeSmokeError(error)}\n`);
  process.exitCode = 1;
} finally {
  await queue?.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
  await database?.$disconnect().catch(() => undefined);
}

async function main() {
  const smoke = readKnowledgeSmokeEnvironment(process.env);
  await assertCheckoutBinding(smoke.binding.candidateCommit);
  let trustPolicy;
  try {
    trustPolicy = await loadProductionTrustPolicy({
      policyPath: smoke.trustPolicy.path,
      expectedSha256: smoke.trustPolicy.sha256,
    });
    assertRuntimeWorkerExecutionTrustPolicy(trustPolicy, smoke.binding);
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_TRUST_POLICY_INVALID");
  }
  const workerDist = path.join(repoRoot, "apps/workbench-worker/dist");
  const [configModule, dbModule, sdk] = await Promise.all([
    importBuilt(workerDist, "config.js"),
    importBuilt(workerDist, "db.js"),
    import("@langchain/langgraph-sdk"),
  ]);
  const config = configModule.loadWorkerConfig();
  if (!config.knowledgeTool) throw new Error("KNOWLEDGE_SMOKE_TOOL_CONFIGURATION_MISSING");
  if (config.deerFlowAssistantId !== smoke.assistantId) {
    throw new Error("KNOWLEDGE_SMOKE_ASSISTANT_CONFIGURATION_MISMATCH");
  }
  // Validate every configured credential before connecting or creating smoke Runs.
  // A malformed deployment must fail closed without external side effects.
  const knownSensitiveValues = collectKnownSmokeSecrets(config, process.env);
  if (knownSensitiveValues.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_SENSITIVE_SCAN_INPUT_MISSING");
  }
  database = dbModule.db;
  await database.$connect();

  const [validPreflight, nullPreflight] = await Promise.all([
    loadAndAssertScope(database, smoke.valid, startRunRequestSchema, smoke),
    loadAndAssertScope(database, smoke.nullRelease, startRunRequestSchema, smoke),
  ]);
  if (validPreflight.request.modelId !== nullPreflight.request.modelId) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_MODEL_MISMATCH");
  }
  if (validPreflight.threadId === nullPreflight.threadId) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_THREADS_MUST_DIFFER");
  }
  const validHeaders = identityHeaders(config, smoke.valid.principalId);
  const nullHeaders = identityHeaders(config, smoke.nullRelease.principalId);
  await Promise.all([
    assertPublicRuntimeSkill(config.deerFlowGatewayUrl, validHeaders),
    assertRuntimeModel(config.deerFlowLangGraphUrl, validHeaders, validPreflight.request.modelId),
    assertRuntimeModel(config.deerFlowLangGraphUrl, nullHeaders, nullPreflight.request.modelId),
  ]);

  const before = assertDeploymentBinding(
    smoke.binding,
    await observeDeploymentBinding(smoke.binding),
  );
  queue = await startRuntimeQueue(config);
  const executionStartedAt = new Date();
  const execution = await enqueueAndWaitForRuns(database, queue, smoke, {
    [smoke.valid.runId]: validPreflight,
    [smoke.nullRelease.runId]: nullPreflight,
  });
  const executionFinishedAt = new Date();
  const after = assertDeploymentBinding(
    smoke.binding,
    await observeDeploymentBinding(smoke.binding),
  );
  if (
    before.runtimeWorkerImageId !== after.runtimeWorkerImageId
    || before.deerFlowImageId !== after.deerFlowImageId
    || before.runtimeWorkerContainerHostnames.join("\u0000")
      !== after.runtimeWorkerContainerHostnames.join("\u0000")
  ) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_CHANGED_DURING_EXECUTION");
  }
  const consumerBinding = assertRuntimeWorkerExecutionBinding(
    execution.jobs,
    execution.attempts.map((attempt) => ({
      runId: attempt.runId,
      runtimeAttemptId: attempt.id,
    })),
    after,
    trustPolicy,
    { startedAt: executionStartedAt, finishedAt: executionFinishedAt },
  );
  const deploymentBinding = Object.freeze({ ...after, ...consumerBinding });
  const attemptReceipts = execution.attempts;

  const receiptByRunId = new Map(attemptReceipts.map((receipt) => [receipt.runId, receipt]));
  if (receiptByRunId.size !== 2) {
    throw new Error("KNOWLEDGE_SMOKE_RUNTIME_ATTEMPT_IDENTITY_MISMATCH");
  }
  const [validPersisted, nullPersisted] = await Promise.all([
    loadPersistedSurfaces(database, smoke.valid, receiptByRunId.get(smoke.valid.runId)),
    loadPersistedSurfaces(database, smoke.nullRelease, receiptByRunId.get(smoke.nullRelease.runId)),
  ]);
  const [validExternal, nullExternal] = await Promise.all([
    loadExternalSurfaces(config, sdk, validHeaders, validPersisted.attempt, smoke.valid.runId),
    loadExternalSurfaces(config, sdk, nullHeaders, nullPersisted.attempt, smoke.nullRelease.runId),
  ]);
  const validPersistedSurfaces = persistedScanSurfaces("valid", validPersisted);
  const nullPersistedSurfaces = persistedScanSurfaces("null", nullPersisted);
  const validPersistedScanCount = assertNoKnowledgeCapabilityLeak(
    validPersistedSurfaces,
    knownSensitiveValues,
  );
  const nullPersistedScanCount = assertNoKnowledgeCapabilityLeak(
    nullPersistedSurfaces,
    knownSensitiveValues,
  );
  const validExternalScanCount = assertNoKnowledgeCapabilityLeak(
    validExternal.scanSurfaces,
    knownSensitiveValues,
  );
  const nullExternalScanCount = assertNoKnowledgeCapabilityLeak(
    nullExternal.scanSurfaces.map((surface) => ({
      label: `null-${surface.label}`,
      value: surface.value,
    })),
    knownSensitiveValues,
  );
  const validScanCount = validPersistedScanCount + validExternalScanCount;
  const nullScanCount = nullPersistedScanCount + nullExternalScanCount;
  const successfulInvocations = validPersisted.grants.flatMap((grant) => grant.invocations)
    .filter((invocation) => invocation.status === "succeeded" && invocation.response !== null);
  if (successfulInvocations.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_SUCCEEDED_INVOCATION_MISSING");
  }
  const proof = assertKnowledgeRetrievalProof({
    deerFlowSurfaces: validExternal.deerFlowSurfaces,
    ledgerResponses: successfulInvocations.map((invocation) => invocation.response),
    releaseId: smoke.valid.releaseId,
    expectedProbe: smoke.expectedProbe,
    expectedCitation: smoke.expectedCitation,
  });
  assertFinalOutputContainsEvidence(
    validPersisted.run.outputEntry?.content,
    smoke.expectedProbe,
    smoke.expectedCitation,
  );
  if (nullPersisted.grants.length !== 0 || nullPersisted.invocationCount !== 0) {
    throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO");
  }
  const nullCatalog = assertKnowledgeCatalogHidden(nullExternal.deerFlowSurfaces);
  assertKnowledgeEvidenceAbsent(
    [...nullExternal.deerFlowSurfaces, nullPersisted.run, nullPersisted.grants],
    smoke.expectedProbe,
    smoke.expectedCitation,
  );
  const isolation = assertConcurrentOppositeScope({
    valid: isolationSurface(smoke.valid, validPersisted, successfulInvocations.length),
    nullRelease: isolationSurface(smoke.nullRelease, nullPersisted, 0),
  });

  const forbiddenValues = [
    ...scopeRawValues(smoke.valid, validPersisted),
    ...scopeRawValues(smoke.nullRelease, nullPersisted),
    smoke.expectedProbe,
    smoke.expectedCitation,
    smoke.valid.query,
    smoke.nullRelease.query,
    ...knownSensitiveValues,
  ];
  const evidence = buildKnowledgeSmokeEvidence({
    binding: deploymentBinding,
    valid: {
      scopeIds: scopeRawValues(smoke.valid, validPersisted),
      releaseId: smoke.valid.releaseId,
      successfulInvocationCount: successfulInvocations.length,
      checkpointStatesScanned: validExternal.history.length,
      structuredValuesScanned: validScanCount,
      persisted: persistedCoverage(
        validPersisted,
        validPersistedScanCount,
        knownSensitiveValues.length,
      ),
      proof,
    },
    nullRelease: {
      scopeIds: scopeRawValues(smoke.nullRelease, nullPersisted),
      grantCount: nullPersisted.grants.length,
      endpointCalls: nullPersisted.invocationCount,
      catalog: nullCatalog,
      checkpointStatesScanned: nullExternal.history.length,
      structuredValuesScanned: nullScanCount,
      persisted: persistedCoverage(
        nullPersisted,
        nullPersistedScanCount,
        knownSensitiveValues.length,
      ),
    },
    isolation,
    forbiddenValues,
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

async function loadAndAssertScope(db, smoke, startRunRequestSchema, expectations) {
  const run = await db.run.findUnique({
    where: { id: smoke.runId },
    select: {
      id: true,
      projectId: true,
      threadId: true,
      createdById: true,
      knowledgeReleaseId: true,
      modelId: true,
      request: true,
      status: true,
      attempt: true,
      outputEntryId: true,
      runtimeAttempts: { select: { id: true } },
      createdBy: { select: { id: true, status: true } },
      thread: {
        select: {
          id: true,
          status: true,
          project: { select: { id: true, workspaceId: true, status: true } },
          runtimeBinding: { select: { id: true } },
        },
      },
      knowledgeRelease: {
        select: {
          id: true,
          workspaceId: true,
          status: true,
          chunksReadyAt: true,
          readyAt: true,
        },
      },
    },
  });
  if (!run) throw new Error("KNOWLEDGE_SMOKE_RUN_NOT_FOUND");
  const release = run.knowledgeRelease;
  if (
    run.id !== smoke.runId
    || run.createdById !== smoke.principalId
    || run.projectId !== smoke.projectId
    || run.thread.project.id !== smoke.projectId
    || run.knowledgeReleaseId !== smoke.releaseId
    || (smoke.releaseId === null ? release !== null : release?.id !== smoke.releaseId)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_SCOPE_MISMATCH");
  }
  if (run.createdBy.status !== "active" || run.thread.status !== "active" || run.thread.project.status !== "active") {
    throw new Error("KNOWLEDGE_SMOKE_SCOPE_NOT_ACTIVE");
  }
  if (run.thread.runtimeBinding !== null) {
    throw new Error("KNOWLEDGE_SMOKE_REQUIRES_FRESH_RUNTIME_THREAD");
  }
  const membership = await db.projectMember.findUnique({
    where: { projectId_principalId: { projectId: smoke.projectId, principalId: smoke.principalId } },
    select: { projectId: true },
  });
  if (!membership) throw new Error("KNOWLEDGE_SMOKE_PROJECT_MEMBERSHIP_MISSING");
  if (smoke.releaseId !== null) {
    if (
      release?.status !== "ready"
      || !release.readyAt
      || !release.chunksReadyAt
      || (release.workspaceId !== null && release.workspaceId !== run.thread.project.workspaceId)
    ) {
      throw new Error("KNOWLEDGE_SMOKE_RELEASE_NOT_READY_OR_SCOPED");
    }
  }
  if (
    run.status !== "queued"
    || run.outputEntryId !== null
    || run.runtimeAttempts.length !== 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_FIXTURE_NOT_FRESH");
  }
  const request = startRunRequestSchema.parse(run.request);
  if (request.modelId !== run.modelId) throw new Error("KNOWLEDGE_SMOKE_MODEL_PIN_MISMATCH");
  if (!request.prompt.includes(smoke.query)) throw new Error("KNOWLEDGE_SMOKE_QUERY_NOT_IN_RUN_PROMPT");
  if (!request.prompt.includes("workbench_knowledge_retrieve")) {
    throw new Error("KNOWLEDGE_SMOKE_TRUSTED_TOOL_NOT_REQUIRED_BY_PROMPT");
  }
  if (
    request.prompt.includes(expectations.expectedProbe)
    || request.prompt.includes(expectations.expectedCitation)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_LEAKED_INTO_RUN_PROMPT");
  }
  return { request, threadId: run.threadId, attempt: run.attempt };
}

async function loadPersistedSurfaces(db, smoke, receipt) {
  if (!receipt) throw new Error("KNOWLEDGE_SMOKE_RUNTIME_ATTEMPT_IDENTITY_MISMATCH");
  const [run, attempt, attemptCount] = await Promise.all([
    db.run.findUnique({
      where: { id: smoke.runId },
      select: {
        id: true,
        projectId: true,
        threadId: true,
        retryOfRunId: true,
        createdById: true,
        designStyleArtifactVersionId: true,
        designStyleSnapshotSha256: true,
        idempotencyKey: true,
        requestHash: true,
        requestId: true,
        status: true,
        phase: true,
        phaseLabel: true,
        progress: true,
        modelId: true,
        traceId: true,
        attempt: true,
        eventSequence: true,
        executionOwnerId: true,
        executionEpoch: true,
        executionHeartbeatAt: true,
        executionLeaseExpiresAt: true,
        cancelRequestedAt: true,
        startedAt: true,
        finishedAt: true,
        errorCode: true,
        errorDetail: true,
        errorRetryable: true,
        cancellationReason: true,
        knowledgeReleaseId: true,
        request: true,
        designStyleSnapshot: true,
        outputEntryId: true,
        createdAt: true,
        updatedAt: true,
        outputEntry: {
          select: {
            id: true,
            threadId: true,
            sequence: true,
            role: true,
            kind: true,
            content: true,
            producedByRunId: true,
            createdAt: true,
          },
        },
        draft: {
          select: { id: true, runId: true, version: true, content: true, updatedAt: true },
        },
        events: {
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            runId: true,
            sourceId: true,
            sequence: true,
            type: true,
            payload: true,
            traceId: true,
            occurredAt: true,
          },
        },
        producedEntries: {
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            threadId: true,
            sequence: true,
            role: true,
            kind: true,
            content: true,
            producedByRunId: true,
            createdAt: true,
          },
        },
        sourceSnapshots: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            runId: true,
            projectId: true,
            position: true,
            sourceId: true,
            kind: true,
            label: true,
            checksum: true,
            descriptor: true,
            snapshot: true,
            createdAt: true,
          },
        },
        artifactVersions: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            artifactId: true,
            projectId: true,
            version: true,
            schemaVersion: true,
            status: true,
            content: true,
            contentBlobId: true,
            checksum: true,
            citations: true,
            createdByRunId: true,
            runtimeDraftSourceId: true,
            runtimeDraftIndex: true,
            runtimeDraftTitle: true,
            knowledgeReleaseId: true,
            createdAt: true,
          },
        },
        thread: {
          select: {
            id: true,
            projectId: true,
            createdById: true,
            title: true,
            status: true,
            revision: true,
            entrySequence: true,
            idempotencyKey: true,
            requestHash: true,
            createdAt: true,
            updatedAt: true,
            entries: {
              orderBy: { sequence: "asc" },
              select: {
                id: true,
                threadId: true,
                sequence: true,
                role: true,
                kind: true,
                content: true,
                producedByRunId: true,
                createdAt: true,
              },
            },
          },
        },
      },
    }),
    db.runtimeAttempt.findFirst({
      where: { id: receipt.id, runId: smoke.runId, attempt: receipt.attempt },
      select: {
        id: true,
        runId: true,
        runtimeBindingId: true,
        attempt: true,
        adapter: true,
        externalThreadId: true,
        externalRunId: true,
        providerIdempotencyKey: true,
        status: true,
        lastExternalEventId: true,
        externalEventSequence: true,
        submissionUnknownAt: true,
        executionOwnerId: true,
        executionEpoch: true,
        executionHeartbeatAt: true,
        executionLeaseExpiresAt: true,
        startedAt: true,
        finishedAt: true,
        errorCode: true,
        errorDetail: true,
        errorRetryable: true,
        createdAt: true,
        updatedAt: true,
        runtimeBinding: {
          select: {
            id: true,
            threadId: true,
            adapter: true,
            externalThreadId: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    }),
    db.runtimeAttempt.count({ where: { runId: smoke.runId } }),
  ]);
  if (!run || !attempt || attemptCount !== 1) {
    throw new Error("KNOWLEDGE_SMOKE_POST_RUN_STATE_MISSING");
  }
  assertRuntimeAttemptIdentityBinding({
    receipt: attempt,
    runId: smoke.runId,
    attempt: receipt.attempt,
    projectId: smoke.projectId,
    principalId: smoke.principalId,
    threadId: run.threadId,
  });
  if (
    run.attempt !== receipt.attempt
    || attempt.id !== receipt.id
    || attempt.runtimeBindingId !== receipt.runtimeBindingId
  ) {
    throw new Error("KNOWLEDGE_SMOKE_RUNTIME_ATTEMPT_IDENTITY_MISMATCH");
  }
  const [grants, invocationCount, externalEvents, providerStates, knowledgeBudgets] = await Promise.all([
    db.knowledgeToolGrant.findMany({
      where: {
        OR: [
          { runtimeAttemptId: attempt.id },
          { runId: smoke.runId },
        ],
      },
      select: {
        id: true,
        runtimeAttemptId: true,
        runId: true,
        principalId: true,
        projectId: true,
        releaseId: true,
        payloadSha256: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        budget: {
          select: {
            runtimeAttemptId: true,
            runtimeAttempt: { select: { id: true, runId: true } },
            maxSuccessfulCalls: true,
            maxConcurrentCalls: true,
            maxStartsPerWindow: true,
            windowSeconds: true,
            maxAttemptsPerInvocation: true,
            maxTotalStarts: true,
            windowStartedAt: true,
            windowStarts: true,
            totalStarts: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        invocations: {
          select: {
            id: true,
            runtimeAttemptId: true,
            invocationId: true,
            lastGrantId: true,
            querySha256: true,
            status: true,
            attemptCount: true,
            leaseToken: true,
            leaseExpiresAt: true,
            response: true,
            responseSha256: true,
            lastErrorCode: true,
            lastStartedAt: true,
            finishedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    }),
    db.knowledgeRetrievalInvocation.count({
      where: {
        OR: [
          { runtimeAttemptId: attempt.id },
          { lastGrant: { is: { runId: smoke.runId } } },
        ],
      },
    }),
    db.runtimeExternalEvent.findMany({
      where: {
        OR: [
          { runtimeAttemptId: attempt.id },
          { runId: smoke.runId },
        ],
      },
      orderBy: { sequence: "asc" },
      select: {
        id: true,
        runtimeAttemptId: true,
        runId: true,
        externalRunId: true,
        externalEventId: true,
        sequence: true,
        event: true,
        payload: true,
        payloadSha256: true,
        status: true,
        receivedAt: true,
        processedAt: true,
      },
    }),
    db.runtimeProviderState.findMany({
      where: {
        OR: [
          { runtimeAttemptId: attempt.id },
          { runId: smoke.runId },
        ],
      },
      select: {
        runtimeAttemptId: true,
        runId: true,
        projectionVersion: true,
        lastAppliedSequence: true,
        lastExternalEventId: true,
        rawAssistantText: true,
        visibleAssistantText: true,
        redactionBuffer: true,
        finalizationExternalEventId: true,
        finalizationPayloadSha256: true,
        stateSha256: true,
        builtAt: true,
        updatedAt: true,
      },
    }),
    db.knowledgeToolBudget.findMany({
      where: {
        OR: [
          { runtimeAttemptId: attempt.id },
          { runtimeAttempt: { is: { runId: smoke.runId } } },
        ],
      },
      select: {
        runtimeAttemptId: true,
        runtimeAttempt: { select: { id: true, runId: true } },
        maxSuccessfulCalls: true,
        maxConcurrentCalls: true,
        maxStartsPerWindow: true,
        windowSeconds: true,
        maxAttemptsPerInvocation: true,
        maxTotalStarts: true,
        windowStartedAt: true,
        windowStarts: true,
        totalStarts: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  const providerState = providerStates[0];
  if (
    !attempt.externalRunId
    || externalEvents.length === 0
    || attempt.externalEventSequence !== externalEvents.length
    || attempt.lastExternalEventId !== externalEvents.at(-1)?.externalEventId
    || externalEvents.some((event, index) => (
      event.runtimeAttemptId !== attempt.id
      || event.runId !== smoke.runId
      || event.externalRunId !== attempt.externalRunId
      || event.sequence !== index + 1
      || event.status !== "processed"
      || !event.processedAt
    ))
    || providerStates.length !== 1
    || providerState.runtimeAttemptId !== attempt.id
    || providerState.runId !== smoke.runId
    || providerState.lastAppliedSequence !== attempt.externalEventSequence
    || providerState.lastExternalEventId !== attempt.lastExternalEventId
    || run.eventSequence !== run.events.length
    || run.events.some((event, index) => event.runId !== smoke.runId || event.sequence !== index + 1)
    || run.outputEntryId !== run.outputEntry?.id
    || run.outputEntry?.producedByRunId !== smoke.runId
    || run.thread.id !== run.threadId
    || run.thread.projectId !== smoke.projectId
    || run.thread.entrySequence !== run.thread.entries.length
    || run.thread.entries.some((entry, index) => (
      entry.threadId !== run.threadId || entry.sequence !== index + 1
    ))
    || run.producedEntries.some((entry) => (
      entry.threadId !== run.threadId || entry.producedByRunId !== smoke.runId
    ))
    || run.sourceSnapshots.some((snapshot) => (
      snapshot.runId !== smoke.runId || snapshot.projectId !== smoke.projectId
    ))
    || run.artifactVersions.some((version) => (
      version.createdByRunId !== smoke.runId || version.projectId !== smoke.projectId
    ))
  ) {
    throw new Error("KNOWLEDGE_SMOKE_RUNTIME_PERSISTED_SURFACE_INCOMPLETE");
  }
  if (
    run.status !== "succeeded"
    || attempt.status !== "succeeded"
    || !attempt.startedAt
    || !attempt.finishedAt
  ) {
    throw new Error("KNOWLEDGE_SMOKE_POST_RUN_NOT_SUCCEEDED");
  }
  if (run.knowledgeReleaseId !== smoke.releaseId) throw new Error("KNOWLEDGE_SMOKE_POST_RUN_SCOPE_MISMATCH");
  const invocations = grants.flatMap((grant) => grant.invocations);
  assertKnowledgeGrantScope(
    { grants, budgets: knowledgeBudgets, invocationCount },
    {
      runtimeAttemptId: attempt.id,
      runId: smoke.runId,
      principalId: smoke.principalId,
      projectId: smoke.projectId,
      releaseId: smoke.releaseId,
    },
  );
  if (
    invocationCount !== invocations.length
    || new Set(invocations.map((invocation) => invocation.id)).size !== invocations.length
    || invocations.some((invocation) => (
      invocation.runtimeAttemptId !== attempt.id
      || !grants.some((grant) => grant.id === invocation.lastGrantId)
    ))
  ) {
    throw new Error("KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH");
  }
  if (smoke.releaseId === null) {
    if (grants.length !== 0 || invocationCount !== 0 || knowledgeBudgets.length !== 0) {
      throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO");
    }
  } else if (
    grants.length !== 1
    || knowledgeBudgets.length !== 1
    || grants[0]?.runtimeAttemptId !== attempt.id
    || grants[0]?.runId !== smoke.runId
    || grants[0]?.principalId !== smoke.principalId
    || grants[0]?.projectId !== smoke.projectId
    || grants[0]?.releaseId !== smoke.releaseId
    || grants[0]?.budget?.runtimeAttemptId !== attempt.id
  ) {
    throw new Error("KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH");
  }
  return {
    run,
    attempt,
    attemptCount,
    grants,
    invocationCount,
    externalEvents,
    providerStates,
    knowledgeBudgets,
  };
}

async function startRuntimeQueue(config) {
  const manager = new PgBoss({
    connectionString: config.queueConnectionString,
    schema: "workbench_jobs",
    application_name: "workbench-deerflow-knowledge-smoke",
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
    useListenNotify: false,
  });
  manager.on("error", () => undefined);
  try {
    await manager.start();
    await createAndAssertRuntimeQueues(manager);
    return manager;
  } catch {
    await manager.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
    throw new Error("KNOWLEDGE_SMOKE_QUEUE_UNAVAILABLE");
  }
}

async function enqueueAndWaitForRuns(db, manager, smoke, preflights) {
  const scopes = [smoke.valid, smoke.nullRelease];
  const jobIds = await Promise.all(scopes.map(async (scope) => {
    let jobId;
    try {
      jobId = await manager.send(
        runtimeExecuteQueue,
        runtimeExecuteSmokeJob(scope.runId),
        {
          singletonKey: scope.runId,
          group: { id: preflights[scope.runId].threadId },
        },
      );
    } catch {
      throw new Error("KNOWLEDGE_SMOKE_QUEUE_ENQUEUE_FAILED");
    }
    if (!jobId) throw new Error("KNOWLEDGE_SMOKE_QUEUE_ENQUEUE_REJECTED");
    return jobId;
  }));
  if (jobIds.length !== scopes.length) throw new Error("KNOWLEDGE_SMOKE_QUEUE_ENQUEUE_REJECTED");

  const deadline = Date.now() + smoke.timeoutMs;
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
  const terminalJobStates = new Set(["completed", "failed", "cancelled"]);
  while (Date.now() < deadline) {
    const [rows, jobs] = await Promise.all([
      db.run.findMany({
        where: { id: { in: scopes.map((scope) => scope.runId) } },
        select: { id: true, status: true },
      }),
      Promise.all(jobIds.map((jobId) => manager.getJobById(runtimeExecuteQueue, jobId))),
    ]);
    if (
      rows.length === scopes.length
      && rows.every((row) => terminalStatuses.has(row.status))
      && jobs.every((job) => job !== null && terminalJobStates.has(job.state))
    ) {
      const expectedAttempts = scopes.map((scope) => ({
        runId: scope.runId,
        attempt: preflights[scope.runId].attempt + 1,
        projectId: scope.projectId,
        principalId: scope.principalId,
        threadId: preflights[scope.runId].threadId,
      }));
      const attempts = await db.runtimeAttempt.findMany({
        where: {
          OR: expectedAttempts.map(({ runId, attempt }) => ({ runId, attempt })),
        },
        select: RUNTIME_ATTEMPT_RECEIPT_SELECT,
      });
      if (attempts.length !== scopes.length) {
        throw new Error("KNOWLEDGE_SMOKE_QUEUE_EXECUTION_ATTEMPT_MISSING");
      }
      for (const expected of expectedAttempts) {
        const receipt = attempts.find((candidate) => candidate.runId === expected.runId);
        assertRuntimeAttemptIdentityBinding({ receipt, ...expected });
      }
      return Object.freeze({ jobIds, statuses: rows, jobs, attempts });
    }
    await delay(smoke.pollIntervalMs);
  }
  throw new Error("KNOWLEDGE_SMOKE_QUEUE_TIMEOUT");
}

function persistedScanSurfaces(label, persisted) {
  return [
    { label: `${label}-workbench-run`, value: persisted.run },
    { label: `${label}-runtime-attempt`, value: persisted.attempt },
    { label: `${label}-runtime-binding`, value: persisted.attempt.runtimeBinding },
    { label: `${label}-runtime-external-events`, value: persisted.externalEvents },
    { label: `${label}-runtime-provider-states`, value: persisted.providerStates },
    { label: `${label}-knowledge-grants`, value: persisted.grants },
    { label: `${label}-knowledge-budgets`, value: persisted.knowledgeBudgets },
  ];
}

function persistedCoverage(persisted, sensitiveValuesScanned, sensitiveValuesChecked) {
  return Object.freeze({
    sensitiveScanCompleted: true,
    sensitiveValuesChecked,
    sensitiveValuesScanned,
    runtimeAttempts: persisted.attemptCount,
    runtimeBindings: persisted.attempt.runtimeBinding ? 1 : 0,
    runtimeExternalEvents: persisted.externalEvents.length,
    runtimeProviderStates: persisted.providerStates.length,
    runEvents: persisted.run.events.length,
    threadEntries: persisted.run.thread.entries.length,
    knowledgeBudgets: persisted.knowledgeBudgets.length,
    knowledgeGrants: persisted.grants.length,
    knowledgeInvocations: persisted.invocationCount,
    sourceSnapshots: persisted.run.sourceSnapshots.length,
    artifactVersions: persisted.run.artifactVersions.length,
  });
}

async function observeDeploymentBinding(binding) {
  const [runtimeWorkers, deerFlows] = await Promise.all([
    inspectDockerServiceReplicas(binding.runtimeWorkerContainer),
    inspectDockerServiceReplicas(binding.deerFlowContainer),
  ]);
  return Object.freeze({ source: "docker-inspect", runtimeWorkers, deerFlows });
}

async function inspectDockerServiceReplicas(anchorName) {
  const anchor = await inspectDockerContainer(anchorName);
  const project = anchor.composeProject;
  const service = anchor.composeService;
  if (!safeDockerLabel(project) || !safeDockerLabel(service)) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_COMPOSE_IDENTITY_MISSING");
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync("docker", [
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", `label=com.docker.compose.service=${service}`,
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_REPLICA_DISCOVERY_FAILED");
  }
  const containerIds = stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).sort();
  if (
    containerIds.length === 0
    || new Set(containerIds).size !== containerIds.length
    || !containerIds.includes(anchor.containerId)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_REPLICA_SET_INVALID");
  }
  const replicas = await Promise.all(containerIds.map((containerId) => inspectDockerContainer(containerId)));
  if (replicas.some((replica) => (
    replica.composeProject !== project || replica.composeService !== service
  ))) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_REPLICA_SET_INVALID");
  }
  return Object.freeze(replicas);
}

async function inspectDockerContainer(containerName) {
  let container;
  try {
    const payload = await dockerJson(["inspect", "--type", "container", containerName]);
    container = Array.isArray(payload) ? payload[0] : payload;
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_CONTAINER_UNAVAILABLE");
  }
  if (!container || typeof container !== "object") {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_CONTAINER_UNAVAILABLE");
  }
  const imageId = container.Image;
  if (typeof imageId !== "string" || imageId.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_IMAGE_UNAVAILABLE");
  }
  let image;
  try {
    const payload = await dockerJson(["image", "inspect", imageId]);
    image = Array.isArray(payload) ? payload[0] : payload;
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_IMAGE_UNAVAILABLE");
  }
  if (!Array.isArray(image?.RepoDigests) || image.RepoDigests.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_IMAGE_DIGEST_UNAVAILABLE");
  }
  return Object.freeze({
    containerId: container.Id,
    hostname: container.Config?.Hostname,
    configuredImageRef: container.Config?.Image,
    containerImageId: imageId,
    running: container.State?.Running,
    status: container.State?.Status,
    healthStatus: container.State?.Health?.Status,
    composeProject: container.Config?.Labels?.["com.docker.compose.project"],
    composeService: container.Config?.Labels?.["com.docker.compose.service"],
    imageId: image?.Id,
    imageLabels: image?.Config?.Labels ?? null,
    repoDigests: image?.RepoDigests ?? [],
    environmentId: dockerEnvironmentValue(container.Config?.Env, "WORKBENCH_ENVIRONMENT_ID"),
    executionKeyId: dockerEnvironmentValue(
      container.Config?.Env,
      "WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID",
    ),
    executionSignerId: dockerEnvironmentValue(
      container.Config?.Env,
      "WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID",
    ),
  });
}

function dockerEnvironmentValue(entries, name) {
  if (!Array.isArray(entries)) return null;
  const prefix = `${name}=`;
  const matches = entries
    .filter((entry) => typeof entry === "string" && entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
  if (
    matches.length > 1
    || (matches.length === 1 && (
      matches[0].length === 0
      || matches[0].length > 512
      || /[\u0000-\u001f\u007f]/u.test(matches[0])
    ))
  ) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_OBSERVATION_INVALID");
  }
  return matches[0] ?? null;
}

async function dockerJson(argumentsList) {
  const { stdout } = await execFileAsync(
    "docker",
    [...argumentsList, "--format", "{{json .}}"],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function safeDockerLabel(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function loadExternalSurfaces(config, sdk, headers, attempt, workbenchRunId) {
  const externalRunId = attempt.externalRunId;
  const externalThreadId = attempt.externalThreadId;
  if (!externalRunId || !externalThreadId) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_MISSING");
  const client = new sdk.Client({
    apiUrl: config.deerFlowLangGraphUrl,
    apiKey: null,
    timeoutMs: config.deerFlowTimeoutMs,
    defaultHeaders: headers,
  });
  const historyMetadata = {
    run_id: externalRunId,
    workbench_run_id: workbenchRunId,
    workbench_runtime_attempt_id: attempt.id,
    workbench_provider_idempotency_key: attempt.providerIdempotencyKey,
    workbench_attempt: attempt.attempt,
  };
  const [externalRun, externalRuns, thread, state, history, scanHistory] = await Promise.all([
    client.runs.get(externalThreadId, externalRunId),
    listCompleteRuns(client, externalThreadId),
    client.threads.get(externalThreadId, { include: ["values", "config", "context"] }),
    client.threads.getState(externalThreadId, undefined, { subgraphs: true }),
    client.threads.getHistory(externalThreadId, {
      limit: HISTORY_LIMIT,
      metadata: historyMetadata,
    }),
    client.threads.getHistory(externalThreadId, { limit: HISTORY_LIMIT }),
  ]);
  assertCompleteHistory(history, HISTORY_LIMIT);
  assertCompleteHistory(scanHistory, HISTORY_LIMIT);
  const expected = {
    externalRunId,
    externalThreadId,
    workbenchRunId,
    runtimeAttemptId: attempt.id,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
    attempt: attempt.attempt,
  };
  assertExternalRunBinding(externalRun, expected);
  assertHistoryBoundToExternalRun(history, expected);
  const selectedRuns = externalRuns.filter((run) => run?.run_id === externalRunId);
  if (selectedRuns.length !== 1) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_MISMATCH");
  assertExternalRunBinding(selectedRuns[0], expected);
  return {
    history,
    deerFlowSurfaces: [externalRun, ...selectedRuns, ...history],
    scanSurfaces: [
      { label: "deerflow-run", value: externalRun },
      { label: "deerflow-run-list", value: selectedRuns },
      { label: "deerflow-thread", value: thread },
      { label: "deerflow-state", value: state },
      { label: "deerflow-history", value: scanHistory },
    ],
  };
}

function isolationSurface(scope, persisted, successfulInvocationCount) {
  return {
    runId: scope.runId,
    runtimeAttemptId: persisted.attempt.id,
    externalThreadId: persisted.attempt.externalThreadId,
    externalRunId: persisted.attempt.externalRunId,
    releaseId: scope.releaseId,
    grantCount: persisted.grants.length,
    invocationCount: persisted.invocationCount,
    successfulInvocationCount,
    startedAt: persisted.attempt.startedAt,
    finishedAt: persisted.attempt.finishedAt,
  };
}

function scopeRawValues(scope, persisted) {
  return [
    scope.runId,
    scope.principalId,
    scope.projectId,
    scope.releaseId,
    persisted.attempt.id,
    persisted.attempt.providerIdempotencyKey,
    persisted.attempt.externalThreadId,
    persisted.attempt.externalRunId,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

async function listCompleteRuns(client, threadId) {
  const runs = await client.runs.list(threadId, { limit: RUN_LIST_LIMIT });
  if (!Array.isArray(runs)) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_INVALID");
  if (runs.length >= RUN_LIST_LIMIT) {
    throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_TRUNCATED");
  }
  return runs;
}

async function assertPublicRuntimeSkill(gatewayUrl, headers) {
  const response = await fetch(`${trimTrailingSlash(gatewayUrl)}/api/skills`, { headers });
  const payload = await responseJson(response, "DEERFLOW_SKILL_CATALOG_FAILED");
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  const skill = skills.find((candidate) => candidate?.name === "workbench");
  if (!skill || skill.category !== "public" || skill.enabled !== true) {
    throw new Error("DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED");
  }
}

async function assertRuntimeModel(langGraphUrl, headers, expectedModel) {
  const response = await fetch(`${trimTrailingSlash(langGraphUrl)}/models`, { headers });
  const payload = await responseJson(response, "DEERFLOW_MODEL_CATALOG_FAILED");
  const names = Array.isArray(payload?.models)
    ? payload.models.map((model) => model?.name).filter((name) => typeof name === "string")
    : [];
  if (!names.includes(expectedModel)) throw new Error("DEERFLOW_PINNED_MODEL_UNAVAILABLE");
}

function identityHeaders(config, principalId) {
  return {
    accept: "application/json",
    "X-DeerFlow-Internal-Token": config.deerFlowInternalToken,
    "X-DeerFlow-Owner-User-Id": principalId,
  };
}

async function assertCheckoutBinding(expectedCommit) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }));
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_UNAVAILABLE");
  }
  if (stdout.trim() !== expectedCommit) {
    throw new Error("KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_MISMATCH");
  }
  let status;
  try {
    ({ stdout: status } = await execFileAsync("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    }));
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_UNAVAILABLE");
  }
  if (status.trim() !== "") {
    throw new Error("KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_DIRTY");
  }
}

async function responseJson(response, errorCode) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${errorCode}:${response.status}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${errorCode}:INVALID_JSON`);
  }
}

function importBuilt(base, relativePath) {
  return import(pathToFileURL(path.join(base, relativePath)).href).catch(() => {
    throw new Error("KNOWLEDGE_SMOKE_WORKER_BUILD_REQUIRED");
  });
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}
