import {
  boardNodeProtocol,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import {
  boardPlacementsForArtifact,
  canonicalJson,
  isRetryableRuntimeError,
  mapRuntimeArtifactTarget,
  mapRuntimeSources,
  mapRuntimeDesignAssets,
  publicErrorMessage,
  prototypeAssetPins,
  RunProcessor,
  RuntimeCancelledError,
  runtimeExecutionErrorCode,
  sha256Canonical,
  validateRuntimeArtifactOperations,
} from "../src/runs/run-processor.js";
import { PrismaCanvasToolGrantIssuer } from "../src/runtime/canvas-tool-grant.service.js";
import { prototypeScreenProjectionChecksum } from "../src/runs/prototype-patch-applier.js";
import {
  RuntimeSubmissionUnknownError,
  type RuntimeCancellationResult,
  type RuntimePort,
  type RuntimeSubmissionState,
} from "../src/runtime/runtime.port.js";
import { RuntimeLivenessError } from "../src/runtime/runtime-liveness.js";
import { runtimeProviderCancellationUnconfirmedCode } from "../src/runs/runtime-cancellation-state.js";
import { runtimePrdResultFixture } from "./runtime-prd-result.fixture.js";

const now = new Date("2026-07-12T00:00:00.000Z");
const executionClaim = {
  runId: "run-1",
  attemptId: "runtime-attempt-1",
  ownerId: "runtime-worker:test",
  epoch: 1,
};
const providerCleanupClaim = {
  ...executionClaim,
  ownerId: "runtime-cleanup:test",
  epoch: 2,
};
function providerCancellationOperationStubs(externalRunId: string | null) {
  return {
    claimProviderCancellation: vi.fn(async () => ({
      disposition: "claimed" as const,
      claim: providerCleanupClaim,
    })),
    releaseProviderCancellation: vi.fn(async () => undefined),
    startProviderCancellationOperation: vi.fn(async (
      _runId: string,
      _attemptId: string,
      hardDeadlineMs: number,
    ) => ({
      runId: executionClaim.runId,
      attemptId: executionClaim.attemptId,
      epoch: 1,
      externalRunId,
      deadlineAt: new Date(Date.now() + hardDeadlineMs),
      monotonicDeadlineAtMs: performance.now() + hardDeadlineMs,
    })),
    finishProviderCancellationOperation: vi.fn(async () => true),
    settleProviderCancellationOperation: vi.fn(async () => "finished" as const),
  };
}
const noKnowledgeToolGrants = () => ({ issue: vi.fn(async () => null) });
const runtimeBindingMetadata = (ownerId = "principal-thread-owner") => ({
  workbenchProjectId: "project-1",
  workbenchThreadId: "thread-1",
  workbenchPrincipalId: ownerId,
});
const runtimeBindingRecord = (ownerId = "principal-binding-owner") => ({
  id: "binding-1",
  adapter: "deerflow",
  externalThreadId: "external-thread-1",
  metadata: runtimeBindingMetadata(ownerId),
});
const runtimeAttemptBinding = (ownerId = "principal-binding-owner") => ({
  runtimeBinding: { metadata: runtimeBindingMetadata(ownerId) },
});
const prototypePatchCoordinator = () => ({
  persistPatch: vi.fn(),
  loadRunBaselinesTx: vi.fn(async () => []),
  synchronizeCheckpointTx: vi.fn(async (_tx: unknown, input: { document: ReturnType<typeof prototypeDocument> }) => (
    input.document.screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      route: screen.route,
      viewport: screen.viewport,
      revision: 0,
      checksum: prototypeScreenProjectionChecksum(input.document, screen.id, 0),
    }))
  )),
  pauseRunTx: vi.fn(),
  activateRunTx: vi.fn(),
  discardRunTx: vi.fn(),
  finalizeVersionTx: vi.fn(),
});

describe("Runtime retry classification", () => {
  it("does not retry deterministic stream protocol or identity failures", () => {
    expect(isRetryableRuntimeError(new Error("DEERFLOW_STREAM_END_INVALID"))).toBe(false);
    expect(isRetryableRuntimeError(new Error("RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT")))
      .toBe(false);
    expect(isRetryableRuntimeError(new Error("RUNTIME_PROVIDER_STATE_HASH_MISMATCH")))
      .toBe(false);
    expect(isRetryableRuntimeError(new Error("RUNTIME_PROVIDER_STATE_MISSING")))
      .toBe(false);
    expect(isRetryableRuntimeError(new Error("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION")))
      .toBe(false);
    expect(isRetryableRuntimeError(new Error("RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR")))
      .toBe(false);
    expect(isRetryableRuntimeError(new Error("RUNTIME_PROVIDER_STATE_NOT_A_REAL_CODE")))
      .toBe(true);
    expect(isRetryableRuntimeError(new Error("socket closed before the runtime stream completed")))
      .toBe(true);
    expect(isRetryableRuntimeError(new RuntimeLivenessError(
      "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
      true,
    ))).toBe(true);
    expect(isRetryableRuntimeError(new RuntimeLivenessError(
      "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      false,
    ))).toBe(false);
  });

  it("persists allowlisted provider-state repair codes without exposing arbitrary errors", () => {
    expect(runtimeExecutionErrorCode(new Error("RUNTIME_PROVIDER_STATE_SEQUENCE_GAP")))
      .toBe("RUNTIME_PROVIDER_STATE_SEQUENCE_GAP");
    expect(runtimeExecutionErrorCode(new Error("RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT")))
      .toBe("RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT");
    expect(runtimeExecutionErrorCode(new Error("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION")))
      .toBe("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION");
    expect(runtimeExecutionErrorCode(new Error("RUNTIME_PROVIDER_STATE_NOT_A_REAL_CODE")))
      .toBe("RUNTIME_EXECUTION_FAILED");
    expect(runtimeExecutionErrorCode(
      new Error("RUNTIME_PROVIDER_STATE_NOT_A_REAL_CODE"),
      "RUNTIME_EXECUTION_RETRYABLE",
    )).toBe("RUNTIME_EXECUTION_RETRYABLE");
  });

  it("extracts an allowlisted invariant from a Prisma wrapper", () => {
    const driverError = {
      cause: {
        kind: "postgres",
        originalCode: "23514",
        originalMessage: "RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT",
      },
    };
    const prismaError = Object.assign(new Error(
      "Invalid runtimeProviderState.update() invocation",
    ), {
      code: "P2004",
      meta: { driverAdapterError: driverError },
    });

    expect(isRetryableRuntimeError(prismaError)).toBe(false);
    expect(runtimeExecutionErrorCode(prismaError))
      .toBe("RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT");
    expect(publicErrorMessage(prismaError))
      .toBe("RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT");
    expect(publicErrorMessage(prismaError)).not.toContain("runtimeProviderState.update");
  });

  it("publishes only controlled error codes and rejects provider text at every nesting depth", () => {
    const secrets = [
      "Bearer provider-bearer-secret",
      `wbkg1.${"a".repeat(64)}.${"b".repeat(43)}`,
      `wbct1.${"c".repeat(64)}.${"d".repeat(43)}`,
      "postgresql://runtime:database-secret@postgres.internal/workbench",
      "prompt: reproduce the customer's private roadmap",
      "response body: upstream returned private generated content",
    ];
    for (const secret of secrets) {
      expect(publicErrorMessage(new Error(secret))).toBe("Runtime execution failed");
      expect(publicErrorMessage(new Error("SDK request failed", {
        cause: new Error(secret),
      }))).toBe("Runtime execution failed");
    }

    const liveness = new RuntimeLivenessError("RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT", true);
    const submissionUnknown = new RuntimeSubmissionUnknownError(
      "RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE",
      { cause: new Error(secrets.join(" ")) },
    );
    expect(publicErrorMessage(new Error("wrapper", { cause: liveness })))
      .toBe("RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT");
    expect(publicErrorMessage(new RuntimeCancelledError())).toBe("RUNTIME_CANCELLED");
    expect(publicErrorMessage(submissionUnknown))
      .toBe("RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE");
    expect(runtimeExecutionErrorCode(submissionUnknown))
      .toBe("RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE");
  });
});

describe("Runtime wall-clock terminalization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => vi.useRealTimers());

  it("bounds an abort-ignoring provider, cancels it, and terminalizes with a stable code", async () => {
    const runtime = {
      execute: vi.fn(async () => new Promise<never>(() => undefined)),
      cancel: vi.fn(async () => ({
        disposition: "cancelled" as const,
        externalRunId: "external-run-1",
        externalStatus: "interrupted",
      })),
    };
    const db = {
      run: { findUnique: vi.fn(async () => ({ status: "running" })) },
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
      undefined,
      { maximumWallClockMs: 900, deadlineCancelMs: 100 },
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        executionLivenessClock: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
        attachExternalRun: ReturnType<typeof vi.fn>;
      };
    };
    Object.assign(internals, {
      prepare: vi.fn(async () => durableExecutionPrepared()),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({ id: "runtime-attempt-1", startedAt: now })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "join",
          providerIdempotencyKey: "wbrt:test-attempt-key",
          externalRunId: "external-run-1",
          lastExternalEventId: null,
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
        attachExternalRun: vi.fn(async () => undefined),
        ...providerCancellationOperationStubs("external-run-1"),
      },
    });
    const failRun = vi.spyOn(internals, "failRun").mockResolvedValue("terminalized");

    const execution = processor.execute("run-1", [], undefined, {
      retryCount: 0,
      retryLimit: 5,
    });
    const observed = execution.catch((error: unknown) => error);
    for (let index = 0; index < 10 && runtime.execute.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(runtime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeTransportOwnerId: "principal-binding-owner",
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    await vi.advanceTimersByTimeAsync(899);
    expect(runtime.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(observed).resolves.toMatchObject({
      code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      retryable: false,
    });
    expect(runtime.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        runtimeAttemptId: "runtime-attempt-1",
        runtimeTransportOwnerId: "principal-binding-owner",
        externalThreadId: "external-thread-1",
        externalRunId: "external-run-1",
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      expect.objectContaining({ code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED" }),
      false,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
        submissionUnknown: false,
      },
    );
  });

  it("terminalizes an expired UNKNOWN attempt instead of resetting its retry budget", async () => {
    const harness = wallClockRecoveryHarness({
      startedAt: now,
      submissions: [{
        mode: "reconcile",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      }],
      execute: async () => new Promise<never>(() => undefined),
      cancel: async () => ({
        disposition: "not_found",
        externalRunId: null,
        externalStatus: null,
      }),
    });

    const execution = harness.processor.execute("run-1", [], undefined, {
      retryCount: 5,
      retryLimit: 5,
    });
    const observed = execution.catch((error: unknown) => error);
    for (let index = 0; index < 10 && harness.runtime.execute.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(900);
    await expect(observed).resolves.toMatchObject({
      code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      retryable: false,
    });

    expect(harness.attempts.claim).toHaveBeenCalledTimes(1);
    expect(harness.runtime.execute).toHaveBeenCalledTimes(1);
    expect(harness.attempts.markSubmissionUnknown).not.toHaveBeenCalled();
    expect(harness.attempts.recordRetryableError).not.toHaveBeenCalled();
    expect(harness.failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      expect.objectContaining({ code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED" }),
      false,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
        submissionUnknown: true,
      },
    );
  });

  it("terminalizes an expired joined attempt when its final cleanup also times out", async () => {
    let providerCancelSignal: AbortSignal | undefined;
    const harness = wallClockRecoveryHarness({
      startedAt: new Date(now.getTime() - 900),
      submissions: [{
        mode: "join",
        providerIdempotencyKey: "wbrt:test-attempt-key",
        externalRunId: "external-run-1",
        lastExternalEventId: null,
      }],
      execute: async () => new Promise<never>(() => undefined),
      cancel: async (_cancellation, _onExternalRunRecovered, signal) => {
        providerCancelSignal = signal;
        return new Promise<never>(() => undefined);
      },
    });

    const execution = harness.processor.execute("run-1", [], undefined, {
      retryCount: 5,
      retryLimit: 5,
    });
    const observed = execution.catch((error: unknown) => error);
    for (let index = 0; index < 10 && harness.runtime.execute.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.runtime.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(providerCancelSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(observed).resolves.toMatchObject({
      code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      retryable: false,
    });
    expect(providerCancelSignal?.aborted).toBe(false);
    expect(harness.attempts.recordRetryableError).not.toHaveBeenCalled();
    expect(harness.failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      expect.objectContaining({ code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED" }),
      false,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
        submissionUnknown: false,
      },
    );
  });

  it("terminalizes an expired submit intent only when it was never authorized", async () => {
    const execute = vi.fn<RuntimePort["execute"]>(async () => {
      throw new Error("runtime.execute must not run for an expired pending submission");
    });
    const harness = wallClockRecoveryHarness({
      startedAt: new Date(now.getTime() - 900),
      submissions: [{
        mode: "submit",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      }],
      execute,
      cancel: async () => ({
        disposition: "not_found",
        externalRunId: null,
        externalStatus: null,
      }),
    });

    await expect(harness.processor.execute("run-1", [], undefined, {
      retryCount: 5,
      retryLimit: 5,
    })).rejects.toMatchObject({
      code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      retryable: false,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(harness.attempts.authorizeSubmission).not.toHaveBeenCalled();
    expect(harness.runtime.cancel).not.toHaveBeenCalled();
    expect(harness.failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      expect.objectContaining({ code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED" }),
      false,
      executionClaim,
    );
  });
});

describe("Runtime provider liveness retry exhaustion", () => {
  it("confirms provider interruption before failing an exhausted stream-idle Run", async () => {
    const idleTimeout = new RuntimeLivenessError(
      "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
      true,
    );
    const harness = runtimeLivenessHarness({
      executionError: idleTimeout,
      submission: {
        mode: "join",
        providerIdempotencyKey: "wbrt:test-attempt-key",
        externalRunId: "external-run-1",
        lastExternalEventId: "provider-event-7",
      },
      cancel: async () => ({
        disposition: "cancelled",
        externalRunId: "external-run-1",
        externalStatus: "interrupted",
      }),
    });

    await expect(harness.processor.execute("run-1", [], undefined, {
      retryCount: 5,
      retryLimit: 5,
    })).rejects.toBe(idleTimeout);

    expect(harness.runtime.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAttemptId: "runtime-attempt-1",
        externalThreadId: "external-thread-1",
        externalRunId: "external-run-1",
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(harness.failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      idleTimeout,
      true,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
        submissionUnknown: false,
      },
    );
    expect(harness.attempts.recordRetryableError).not.toHaveBeenCalled();
    expect(harness.attempts.markSubmissionUnknown).not.toHaveBeenCalled();
  });

  it("terminalizes an exhausted ambiguous submission when metadata lookup finds no Run", async () => {
    const submissionTimeout = new RuntimeLivenessError(
      "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
      true,
    );
    const ambiguity = new RuntimeSubmissionUnknownError("RUNTIME_SUBMISSION_UNKNOWN", {
      cause: submissionTimeout,
    });
    const harness = runtimeLivenessHarness({
      executionError: ambiguity,
      submission: {
        mode: "submit",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      },
      submissionStarted: true,
      cancel: async () => ({
        disposition: "not_found",
        externalRunId: null,
        externalStatus: null,
      }),
    });

    await expect(harness.processor.execute("run-1", [], undefined, {
      retryCount: 5,
      retryLimit: 5,
    })).rejects.toBe(submissionTimeout);

    expect(harness.attempts.authorizeSubmission).toHaveBeenCalledWith(executionClaim);
    expect(harness.runtime.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ externalRunId: null }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(harness.attempts.markSubmissionUnknown).not.toHaveBeenCalled();
    expect(harness.attempts.recordRetryableError).not.toHaveBeenCalled();
    expect(harness.failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      submissionTimeout,
      true,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
        submissionUnknown: true,
      },
    );
  });

  it("terminalizes a known external Run when final provider cancellation times out", async () => {
    vi.useFakeTimers();
    try {
      const idleTimeout = new RuntimeLivenessError(
        "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
        true,
      );
      let providerSignal: AbortSignal | undefined;
      const harness = runtimeLivenessHarness({
        executionError: idleTimeout,
        submission: {
          mode: "join",
          providerIdempotencyKey: "wbrt:test-attempt-key",
          externalRunId: "external-run-1",
          lastExternalEventId: null,
        },
        deadlineCancelMs: 100,
        cancel: async (_cancellation, _onExternalRunRecovered, signal) => {
          providerSignal = signal;
          return new Promise<never>(() => undefined);
        },
      });

      const execution = harness.processor.execute("run-1", [], undefined, {
        retryCount: 5,
        retryLimit: 5,
      });
      const observed = execution.catch((error: unknown) => error);
      for (let index = 0; index < 25 && harness.runtime.cancel.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(harness.runtime.cancel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(providerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(observed).resolves.toBe(idleTimeout);
      expect(providerSignal?.aborted).toBe(false);
      expect(harness.attempts.recordRetryableError).not.toHaveBeenCalled();
      expect(harness.attempts.markSubmissionUnknown).not.toHaveBeenCalled();
      expect(harness.failRun).toHaveBeenCalledWith(
        "run-1",
        "runtime-attempt-1",
        idleTimeout,
        true,
        executionClaim,
        {
          code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
          detailCode: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
          submissionUnknown: false,
        },
      );
      await vi.advanceTimersByTimeAsync(44_900);
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records late provider success as settled and terminalizes with the local failure", async () => {
    const submissionTimeout = new RuntimeLivenessError(
      "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
      true,
    );
    const ambiguity = new RuntimeSubmissionUnknownError("RUNTIME_SUBMISSION_UNKNOWN", {
      cause: submissionTimeout,
    });
    const harness = runtimeLivenessHarness({
      executionError: ambiguity,
      submission: {
        mode: "submit",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      },
      submissionStarted: true,
      cancel: async (_cancellation, onExternalRunRecovered) => {
        await onExternalRunRecovered("external-run-late");
        return {
          disposition: "already_terminal",
          externalRunId: "external-run-late",
          externalStatus: "success",
        };
      },
    });

    await expect(harness.processor.execute("run-1", [], undefined, {
      retryCount: 5,
      retryLimit: 5,
    })).rejects.toBe(submissionTimeout);

    expect(harness.attempts.attachExternalRunForCleanup).toHaveBeenCalledWith(
      executionClaim.attemptId,
      1,
      "external-run-late",
    );
    expect(harness.attempts.recordRetryableError).not.toHaveBeenCalled();
    expect(harness.attempts.attachExternalRunForCleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
      harness.failRun.mock.invocationCallOrder[0]!,
    );
    expect(harness.attempts.markSubmissionUnknown).not.toHaveBeenCalled();
    expect(harness.failRun).toHaveBeenCalledWith(
      "run-1",
      "runtime-attempt-1",
      submissionTimeout,
      true,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
        submissionUnknown: true,
      },
    );
  });

  it("persists a recovered external Run id after cleanup timeout releases the claim", async () => {
    vi.useFakeTimers();
    try {
      const idleTimeout = new RuntimeLivenessError(
        "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
        true,
      );
      const providerCancellation = deferred<RuntimeCancellationResult>();
      let recoverExternalRun!: () => Promise<void>;
      const harness = runtimeLivenessHarness({
        executionError: idleTimeout,
        submission: {
          mode: "submit",
          providerIdempotencyKey: "wbrt:test-attempt-key",
        },
        submissionStarted: true,
        deadlineCancelMs: 100,
        cancel: async (_cancellation, onExternalRunRecovered) => {
          recoverExternalRun = async () => {
            await onExternalRunRecovered("external-run-late");
            providerCancellation.resolve({
              disposition: "already_terminal",
              externalRunId: "external-run-late",
              externalStatus: "success",
            });
          };
          return providerCancellation.promise;
        },
      });

      const execution = harness.processor.execute("run-1", [], undefined, {
        retryCount: 5,
        retryLimit: 5,
      });
      const observed = execution.catch((error: unknown) => error);
      for (let index = 0; index < 10 && harness.runtime.cancel.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(100);

      await expect(observed).resolves.toBe(idleTimeout);
      expect(harness.failRun).toHaveBeenCalledTimes(1);
      await recoverExternalRun();
      expect(harness.attempts.attachExternalRunForCleanup).toHaveBeenCalledWith(
        "runtime-attempt-1",
        1,
        "external-run-late",
      );
      expect(harness.attempts.attachExternalRunForCleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
        harness.failRun.mock.invocationCallOrder[0]!,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function durableExecutionPrepared() {
  return {
    run: {
      id: "run-1",
      attempt: 1,
      createdById: "principal-1",
      knowledgeReleaseId: null,
    },
    thread: { id: "thread-1", createdById: "principal-thread-owner" },
    project: { id: "project-1" },
    entryId: "entry-1",
    request: {
      prompt: "Build it",
      modelId: "model-1",
      workflow: "generate" as const,
      targetSurface: "app" as const,
      designStyle: { kind: "automatic" as const },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: [],
    },
    artifactTargets: [],
    prototypePatchBaselines: [],
    sources: [],
    designAssets: [],
    designStyleSnapshot: null,
    resume: null,
    previousAssistantText: "",
  };
}

function emptyProviderTextState(visibleAssistantText = "") {
  return {
    protocol: "workbench.runtime-provider-text-state.v2" as const,
    rawAssistantText: visibleAssistantText,
    visibleAssistantText,
    durableVisibleAssistantText: visibleAssistantText,
    redactionBuffer: "",
    committedFinalization: null,
  };
}

type RuntimeCancelStub = (
  cancellation: unknown,
  onExternalRunRecovered: (externalRunId: string) => Promise<void>,
  signal?: AbortSignal,
) => Promise<RuntimeCancellationResult>;

function wallClockRecoveryHarness(input: {
  startedAt: Date;
  submissions: RuntimeSubmissionState[];
  execute: RuntimePort["execute"];
  cancel: RuntimeCancelStub;
}) {
  const runtime = {
    execute: vi.fn(input.execute),
    cancel: vi.fn(input.cancel),
  };
  const db = {
    run: { findUnique: vi.fn(async () => ({ status: "running" })) },
  };
  const processor = new RunProcessor(
    db as never,
    runtime as never,
    noKnowledgeToolGrants(),
    undefined,
    prototypePatchCoordinator() as never,
    undefined,
    { maximumWallClockMs: 900, deadlineCancelMs: 100 },
  );
  let submissionIndex = 0;
  const attempts = {
    ensure: vi.fn(async () => ({ id: "runtime-attempt-1", startedAt: input.startedAt })),
    claim: vi.fn(async () => executionClaim),
    submissionContext: vi.fn(async () => (
      input.submissions[Math.min(submissionIndex++, input.submissions.length - 1)]!
    )),
    executionLivenessClock: vi.fn(async () => ({
      databaseNow: now,
      startedAt: input.startedAt,
    })),
    providerTextState: vi.fn(async () => emptyProviderTextState()),
    authorizeSubmission: vi.fn(async () => undefined),
    attachExternalRun: vi.fn(async () => undefined),
    attachExternalRunForCleanup: vi.fn(async (_attemptId, _epoch, externalRunId) => ({
      externalRunId,
      operationCurrent: true,
    })),
    ...providerCancellationOperationStubs(
      "externalRunId" in input.submissions[0]! ? input.submissions[0]!.externalRunId : null,
    ),
    markSubmissionUnknown: vi.fn(async () => undefined),
    recordRetryableError: vi.fn(async () => undefined),
  };
  const internals = processor as unknown as ProcessorInternals & {
    bindings: { ensure: ReturnType<typeof vi.fn> };
    attempts: typeof attempts;
  };
  const publishResult = vi.fn(async () => undefined);
  Object.assign(internals, {
    prepare: vi.fn(async () => durableExecutionPrepared()),
    bindings: {
      ensure: vi.fn(async () => runtimeBindingRecord()),
    },
    attempts,
    publishResult,
  });
  const failRun = vi.spyOn(internals, "failRun").mockResolvedValue("terminalized");
  return { attempts, failRun, processor, publishResult, runtime };
}

function runtimeLivenessHarness(input: {
  executionError: Error;
  submission: RuntimeSubmissionState;
  submissionStarted?: boolean;
  cancel: RuntimeCancelStub;
  deadlineCancelMs?: number;
}) {
  const runtime = {
    execute: vi.fn(async (_execution: unknown, observer: {
      onSubmissionStarted(): Promise<void>;
    }) => {
      if (input.submissionStarted) await observer.onSubmissionStarted();
      throw input.executionError;
    }),
    cancel: vi.fn(input.cancel),
  };
  const db = {
    run: { findUnique: vi.fn(async () => ({ status: "running" })) },
  };
  const processor = new RunProcessor(
    db as never,
    runtime as never,
    noKnowledgeToolGrants(),
    undefined,
    prototypePatchCoordinator() as never,
    undefined,
    {
      maximumWallClockMs: 10_000,
      deadlineCancelMs: input.deadlineCancelMs ?? 100,
    },
  );
  const attempts = {
    ensure: vi.fn(async () => ({ id: "runtime-attempt-1" })),
    claim: vi.fn(async () => executionClaim),
    submissionContext: vi.fn(async () => input.submission),
    executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
    providerTextState: vi.fn(async () => emptyProviderTextState()),
    authorizeSubmission: vi.fn(async () => undefined),
    attachExternalRun: vi.fn(async () => undefined),
    attachExternalRunForCleanup: vi.fn(async (_attemptId, _epoch, externalRunId) => ({
      externalRunId,
      operationCurrent: true,
    })),
    ...providerCancellationOperationStubs(
      "externalRunId" in input.submission ? input.submission.externalRunId : null,
    ),
    markSubmissionUnknown: vi.fn(async () => undefined),
    recordRetryableError: vi.fn(async () => undefined),
  };
  const internals = processor as unknown as ProcessorInternals & {
    bindings: { ensure: ReturnType<typeof vi.fn> };
    attempts: typeof attempts;
  };
  Object.assign(internals, {
    prepare: vi.fn(async () => durableExecutionPrepared()),
    bindings: {
      ensure: vi.fn(async () => runtimeBindingRecord()),
    },
    attempts,
  });
  const failRun = vi.spyOn(internals, "failRun").mockResolvedValue("terminalized");
  return { attempts, failRun, processor, runtime };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

type CancellationPollerInternals = {
  active: Map<string, AbortController>;
  cancellationPollTimer: NodeJS.Timeout | null;
  cancellationPollInFlight: boolean;
  startCancellationPoller(): void;
  pollActiveRunsForCancellation(): Promise<void>;
};

describe("RunProcessor shared cancellation poller", () => {
  it("uses one batch query for all active Runs and aborts every matching controller", async () => {
    const findMany = vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]);
    const processor = new RunProcessor(
      { run: { findMany } } as never,
      {} as never,
      noKnowledgeToolGrants(),
    ) as unknown as CancellationPollerInternals;
    const first = new AbortController();
    const second = new AbortController();
    processor.active.set("run-1", first);
    processor.active.set("run-2", second);

    await processor.pollActiveRunsForCancellation();

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["run-1", "run-2"] },
        status: { in: ["cancelling", "cancelled"] },
      },
      select: { id: true },
    });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.reason).toBeInstanceOf(RuntimeCancelledError);
    expect(second.signal.reason).toBeInstanceOf(RuntimeCancelledError);
  });

  it("does not overlap a slow poll and stops its timer after becoming idle", async () => {
    const pending = deferred<Array<{ id: string }>>();
    const findMany = vi.fn(() => pending.promise);
    const processor = new RunProcessor(
      { run: { findMany } } as never,
      {} as never,
      noKnowledgeToolGrants(),
    ) as unknown as CancellationPollerInternals;
    processor.active.set("run-1", new AbortController());
    processor.startCancellationPoller();

    const first = processor.pollActiveRunsForCancellation();
    const overlapping = processor.pollActiveRunsForCancellation();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(processor.cancellationPollInFlight).toBe(true);

    processor.active.clear();
    pending.resolve([]);
    await Promise.all([first, overlapping]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(processor.cancellationPollInFlight).toBe(false);
    expect(processor.cancellationPollTimer).toBeNull();
  });

  it("splits cancellation status reads into bounded batches", async () => {
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => (
      where.id.in.map((id) => ({ id }))
    ));
    const processor = new RunProcessor(
      { run: { findMany } } as never,
      {} as never,
      noKnowledgeToolGrants(),
      undefined,
      undefined,
      undefined,
      { cancellationQueryBatchSize: 2 },
    ) as unknown as CancellationPollerInternals;
    const controllers = ["run-1", "run-2", "run-3"].map((id) => {
      const controller = new AbortController();
      processor.active.set(id, controller);
      return controller;
    });

    await processor.pollActiveRunsForCancellation();

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls.map(([input]) => input.where.id.in)).toEqual([
      ["run-1", "run-2"],
      ["run-3"],
    ]);
    for (const controller of controllers) expect(controller.signal.aborted).toBe(true);
  });
});

describe("Artifact Board placement", () => {
  it("uses the reference square placement for a PRD", () => {
    const prd = runtimePrdResultFixture.artifacts.find((artifact) => artifact.kind === "prd");
    expect(prd).toBeDefined();

    expect(boardPlacementsForArtifact(prd!)).toEqual([{
      key: "root",
      size: { width: 500, height: 500 },
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: prd!.title,
        artifactKind: "prd",
      },
    }]);
  });

  it("creates one durable Board node per Prototype screen", () => {
    const placements = boardPlacementsForArtifact({
      kind: "prototype",
      schemaVersion: 1,
      title: "Check-in flow",
      citations: [],
      operation: { kind: "create" },
      content: prototypeDocument(),
    });

    expect(placements).toEqual([
      {
        key: "screen:screen-home",
        size: { width: 390, height: 844 },
        data: {
          protocol: boardNodeProtocol,
          nodeType: "artifact",
          title: "Home",
          artifactKind: "prototype",
          screenId: "screen-home",
          route: "/",
        },
      },
      {
        key: "screen:screen-success",
        size: { width: 390, height: 844 },
        data: {
          protocol: boardNodeProtocol,
          nodeType: "artifact",
          title: "Success",
          artifactKind: "prototype",
          screenId: "screen-success",
          route: "/success",
        },
      },
    ]);
  });

  it("uses a stable root placement for non-screen artifacts", () => {
    expect(boardPlacementsForArtifact({
      kind: "document",
      schemaVersion: 1,
      title: "Research notes",
      citations: [],
      operation: { kind: "create" },
      content: { text: "notes" },
    })).toEqual([{
      key: "root",
      size: { width: 800, height: 600 },
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: "Research notes",
        artifactKind: "document",
      },
    }]);
  });
});

describe("Runtime Artifact target snapshots", () => {
  it("materializes the exact inline Prototype and selected screens", () => {
    const content = prototypeDocument();
    const target = {
      artifactId: "artifact-target",
      artifactVersionId: "version-target",
      screenIds: ["screen-home"],
    };
    const snapshot = mapRuntimeArtifactTarget("project-1", target, {
      id: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      status: "ready",
      schemaVersion: 1,
      checksum: sha256Canonical(content),
      content,
      contentBlob: null,
      artifact: { kind: "prototype" },
      assets: [],
    } as never);

    expect(snapshot).toMatchObject({
      ...target,
      kind: "prototype",
      content: { mode: "inline", value: content },
    });
  });

  it("rejects forged screens and checksum drift before calling DeerFlow", () => {
    const content = prototypeDocument();
    const row = {
      id: "version-target",
      artifactId: "artifact-target",
      projectId: "project-1",
      status: "ready",
      schemaVersion: 1,
      checksum: sha256Canonical(content),
      content,
      contentBlob: null,
      artifact: { kind: "prototype" },
      assets: [],
    };
    expect(() => mapRuntimeArtifactTarget("project-1", {
      artifactId: "artifact-target",
      artifactVersionId: "version-target",
      screenIds: ["screen-forged"],
    }, row as never)).toThrow("RUNTIME_ARTIFACT_TARGET_SCREEN_INVALID");
    expect(() => mapRuntimeArtifactTarget("project-1", {
      artifactId: "artifact-target",
      artifactVersionId: "version-target",
      screenIds: ["screen-home"],
    }, { ...row, checksum: "0".repeat(64) } as never)).toThrow("RUNTIME_ARTIFACT_TARGET_CHECKSUM_INVALID");
  });

  it("materializes exact pins but exposes only selected-screen asset dependencies to Generate", () => {
    const binary = {
      id: "hero-image",
      kind: "image" as const,
      name: "Hero",
      blobId: "blob-image",
      mediaType: "image/png" as const,
      byteSize: 16,
      sha256: "d".repeat(64),
      width: 320,
      height: 180,
    };
    const content = { ...prototypeDocument(), assets: [binary] };
    const target = {
      artifactId: "artifact-target",
      artifactVersionId: "version-target",
      screenIds: ["screen-home"],
    };
    const assetPin = {
      artifactVersionId: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      assetId: binary.id,
      kind: binary.kind,
      blobId: binary.blobId,
      mediaType: binary.mediaType,
      byteSize: BigInt(binary.byteSize),
      sha256: binary.sha256,
      metadata: binary,
      blob: {
        id: binary.blobId,
        status: "ready",
        deletedAt: null,
        storageKey: "tenant/private/hero",
        mediaType: binary.mediaType,
        byteSize: BigInt(binary.byteSize),
        sha256: binary.sha256,
      },
    };
    const row = {
      id: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      status: "ready",
      schemaVersion: 1,
      checksum: sha256Canonical(content),
      content,
      contentBlob: null,
      artifact: { kind: "prototype" },
      assets: [assetPin],
    };

    expect(mapRuntimeArtifactTarget("project-1", target, row as never).assets).toEqual([{
      artifactVersionId: target.artifactVersionId,
      assetId: binary.id,
      kind: binary.kind,
      blobId: binary.blobId,
      mediaType: binary.mediaType,
      byteSize: binary.byteSize,
      sha256: binary.sha256,
      metadata: binary,
      content: {
        storageKey: "tenant/private/hero",
        mediaType: binary.mediaType,
        byteSize: binary.byteSize,
        sha256: binary.sha256,
      },
    }]);
    const generateSource = mapRuntimeArtifactTarget(
      "project-1",
      target,
      row as never,
      "generate-source",
    );
    expect(generateSource.assets).toEqual([]);
    expect(generateSource.content).toMatchObject({
      mode: "inline",
      value: {
        protocol: "workbench.prototype-source-projection.v1",
        selectedScreenIds: ["screen-home"],
        assets: [],
      },
    });
    expect(JSON.stringify(generateSource.content)).not.toContain("screen-success");
    expect(JSON.stringify(generateSource.content)).not.toContain(binary.blobId);
    expect(() => mapRuntimeArtifactTarget("project-1", target, {
      ...row,
      assets: [],
    } as never)).toThrow("RUNTIME_ARTIFACT_TARGET_ASSET_PIN_MISMATCH");
    expect(() => mapRuntimeArtifactTarget("project-1", target, {
      ...row,
      assets: [{ ...assetPin, sha256: "e".repeat(64) }],
    } as never)).toThrow("RUNTIME_ARTIFACT_TARGET_ASSET_SOURCE_INVALID:hero-image");
    expect(() => mapRuntimeArtifactTarget("project-1", target, {
      ...row,
      assets: [{ ...assetPin, metadata: { ...binary, width: 321 } }],
    } as never)).toThrow("RUNTIME_ARTIFACT_TARGET_ASSET_SOURCE_INVALID:hero-image");
    expect(() => mapRuntimeArtifactTarget("project-1", target, {
      ...row,
      assets: [{ ...assetPin, blob: { ...assetPin.blob, deletedAt: now } }],
    } as never)).toThrow("RUNTIME_ARTIFACT_TARGET_ASSET_SOURCE_INVALID:hero-image");
  });

  it("projects only assets actually used by the selected source screen", () => {
    const hero = {
      id: "hero-image",
      kind: "image" as const,
      name: "Hero",
      blobId: "blob-hero",
      mediaType: "image/png" as const,
      byteSize: 16,
      sha256: "d".repeat(64),
      width: 320,
      height: 180,
    };
    const unused = {
      id: "unused-image",
      kind: "image" as const,
      name: "Unused",
      blobId: "blob-unused",
      mediaType: "image/png" as const,
      byteSize: 32,
      sha256: "e".repeat(64),
      width: 640,
      height: 360,
    };
    const document = {
      ...prototypeDocument(),
      assets: [hero, unused],
    };
    const homeFrame = document.nodes.find((node) => node.id === "frame-home");
    if (!homeFrame || homeFrame.kind !== "frame") throw new Error("fixture frame missing");
    const imageNode = {
      id: "image-home",
      screenId: "screen-home",
      parentId: homeFrame.id,
      name: "Hero image",
      visible: true,
      layout: homeFrame.layout,
      style: homeFrame.style,
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "image" as const,
      assetId: hero.id,
      fit: "cover" as const,
      alt: "Hero",
    };
    document.nodes = document.nodes.map((node) => (
      node.id === homeFrame.id
        ? { ...node, childIds: [imageNode.id] }
        : node
    ));
    document.nodes.push(imageNode);
    const target = {
      artifactId: "artifact-target",
      artifactVersionId: "version-target",
      screenIds: ["screen-home"],
    };
    const pin = (asset: typeof hero) => ({
      artifactVersionId: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      assetId: asset.id,
      kind: asset.kind,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: BigInt(asset.byteSize),
      sha256: asset.sha256,
      metadata: asset,
      blob: {
        id: asset.blobId,
        status: "ready",
        deletedAt: null,
        storageKey: `tenant/private/${asset.id}`,
        mediaType: asset.mediaType,
        byteSize: BigInt(asset.byteSize),
        sha256: asset.sha256,
      },
    });
    const row = {
      id: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      status: "ready",
      schemaVersion: 1,
      checksum: sha256Canonical(document),
      content: document,
      contentBlob: null,
      artifact: { kind: "prototype" },
      assets: [pin(hero), pin(unused)],
    };

    const projected = mapRuntimeArtifactTarget(
      "project-1",
      target,
      row as never,
      "generate-source",
    );

    expect(projected.assets.map((asset) => asset.assetId)).toEqual([hero.id]);
    expect(projected.content).toMatchObject({
      mode: "inline",
      value: {
        protocol: "workbench.prototype-source-projection.v1",
        selectedScreenIds: ["screen-home"],
        assets: [hero],
      },
    });
    expect(JSON.stringify(projected.content)).not.toContain(unused.id);
    expect(JSON.stringify(projected.content)).not.toContain(unused.blobId);
  });
});

describe("Runtime Artifact publication operations", () => {
  const target = {
    artifactId: "artifact-target",
    artifactVersionId: "version-target",
    screenIds: ["screen-home"],
  };
  const editRequest = {
    prompt: "Edit the selected screen",
    modelId: "quality",
    workflow: "edit" as const,
    targetSurface: "app" as const,
    designStyle: { kind: "automatic" as const },
    sourceIds: [],
    artifactTargets: [target],
    requestedArtifactKinds: ["prototype" as const],
  };
  const revision = {
    protocol: "workbench.runtime.result.v1" as const,
    message: "done",
    artifacts: [{
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: "Prototype",
      citations: [],
      operation: { kind: "revise" as const, target },
      content: prototypeDocument(),
    }],
  };

  it("requires edit results to revise every exact requested target", () => {
    expect(() => validateRuntimeArtifactOperations(editRequest, revision)).not.toThrow();
    expect(() => validateRuntimeArtifactOperations(editRequest, {
      ...revision,
      artifacts: [],
    })).toThrow("RUNTIME_ARTIFACT_REVISION_TARGETS_INCOMPLETE");
    expect(() => validateRuntimeArtifactOperations(editRequest, {
      ...revision,
      artifacts: [{
        ...revision.artifacts[0]!,
        operation: { kind: "revise", target: { ...target, screenIds: ["screen-success"] } },
      }],
    })).toThrow("RUNTIME_ARTIFACT_REVISION_TARGET_INVALID");
  });

  it("rejects revision output from non-edit workflows", () => {
    expect(() => validateRuntimeArtifactOperations({
      ...editRequest,
      workflow: "generate",
    }, revision)).toThrow("RUNTIME_ARTIFACT_REVISION_NOT_ALLOWED");
  });

  it("rejects result kinds that the Run did not request", () => {
    expect(() => validateRuntimeArtifactOperations({
      ...editRequest,
      workflow: "generate",
      artifactTargets: [],
      requestedArtifactKinds: ["prd"],
    }, {
      ...revision,
      artifacts: [{
        ...revision.artifacts[0]!,
        operation: { kind: "create" },
      }],
    })).toThrow("RUNTIME_ARTIFACTS_UNREQUESTED:prototype");
  });
});

describe("Runtime Artifact revision publication", () => {
  function revisionHarness(nextContent = {
    ...prototypeDocument(),
    revision: 2,
    nodes: prototypeDocument().nodes.map((node) => (
      node.screenId === "screen-home" ? { ...node, name: "edited-home" } : node
    )),
  }) {
    const baseContent = prototypeDocument();
    const target = {
      artifactId: "artifact-target",
      artifactVersionId: "version-base",
      screenIds: ["screen-home"],
    };
    const tx = {
      $queryRaw: vi.fn(async (query: unknown) => (
        rawSqlText(query).includes('FROM "artifact_version_assets"')
          ? []
          : [{
              id: target.artifactId,
              kind: "prototype",
              currentVersionId: target.artifactVersionId,
            }]
      )),
      artifactVersion: {
        findUnique: vi.fn(async () => ({
          id: target.artifactVersionId,
          artifactId: target.artifactId,
          projectId: "project-1",
          version: 1,
          schemaVersion: 1,
          status: "ready",
          content: baseContent,
          contentBlobId: null,
          knowledgeReleaseId: null,
          assets: [],
        })),
        findFirst: vi.fn(async () => ({
          id: "version-next",
          artifactId: target.artifactId,
          projectId: "project-1",
          version: 2,
          schemaVersion: 1,
          status: "staging",
          content: nextContent,
          contentBlobId: null,
          checksum: sha256Canonical(nextContent),
          citations: [],
          runtimeDraftIndex: 0,
          runtimeDraftTitle: "Updated prototype",
          artifact: {
            id: target.artifactId,
            kind: "prototype",
            currentVersionId: target.artifactVersionId,
          },
          assets: [],
        })),
        update: vi.fn(async () => ({ id: "version-next", artifactId: target.artifactId, version: 2 })),
      },
      artifactVersionAsset: { createMany: vi.fn(async () => ({ count: 0 })) },
      artifact: { update: vi.fn(async () => ({ revision: 2 })) },
      boardNode: {
        findMany: vi.fn(async () => [{
          id: "node-home",
          data: { screenId: "screen-home" },
        }]),
        update: vi.fn(async () => ({})),
      },
    };
    const processor = new RunProcessor(
      {} as never,
      {} as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    ) as unknown as ProcessorInternals;
    const draft = {
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: "Updated prototype",
      citations: [],
      operation: { kind: "revise" as const, target },
      content: nextContent,
    };
    return { draft, processor, target, tx };
  }

  function prdRevisionHarness(baseSchemaVersion = 2) {
    const baseContent = prdDocumentV2Example;
    const nextContent = {
      ...baseContent,
      revision: {
        ...baseContent.revision,
        number: baseContent.revision.number + 1,
        summary: "Runtime revision",
      },
    };
    const target = {
      artifactId: "artifact-prd-target",
      artifactVersionId: "version-prd-base",
      screenIds: [],
    };
    const tx = {
      $queryRaw: vi.fn(async (query: unknown) => (
        rawSqlText(query).includes('FROM "artifact_version_assets"')
          ? []
          : [{
              id: target.artifactId,
              kind: "prd",
              currentVersionId: target.artifactVersionId,
            }]
      )),
      artifactVersion: {
        findUnique: vi.fn(async () => ({
          id: target.artifactVersionId,
          artifactId: target.artifactId,
          projectId: "project-1",
          version: 1,
          schemaVersion: baseSchemaVersion,
          status: "ready",
          content: baseContent,
          contentBlobId: null,
          knowledgeReleaseId: null,
        })),
        findFirst: vi.fn(async () => ({
          id: "version-prd-next",
          artifactId: target.artifactId,
          projectId: "project-1",
          version: 2,
          schemaVersion: 2,
          status: "staging",
          content: nextContent,
          contentBlobId: null,
          checksum: sha256Canonical(nextContent),
          citations: [],
          runtimeDraftIndex: 0,
          runtimeDraftTitle: nextContent.title,
          artifact: {
            id: target.artifactId,
            kind: "prd",
            currentVersionId: target.artifactVersionId,
          },
        })),
        update: vi.fn(async () => ({
          id: "version-prd-next",
          artifactId: target.artifactId,
          version: 2,
        })),
      },
      artifact: { update: vi.fn(async () => ({ revision: 2 })) },
      boardNode: {
        findMany: vi.fn(async () => [{ id: "node-prd", data: {} }]),
        update: vi.fn(async () => ({})),
      },
    };
    const processor = new RunProcessor(
      {} as never,
      {} as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    ) as unknown as ProcessorInternals;
    const draft = {
      kind: "prd" as const,
      schemaVersion: 2 as const,
      title: nextContent.title,
      citations: [],
      operation: { kind: "revise" as const, target },
      content: nextContent,
    };
    return { draft, processor, target, tx };
  }

  it("promotes the staged next immutable version and advances existing Board pins", async () => {
    const { draft, processor, target, tx } = revisionHarness();
    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      draft,
      0,
    )).resolves.toEqual({ id: "version-next", artifactId: target.artifactId, version: 2 });
    expect(tx.artifactVersion.update).toHaveBeenCalledWith({
      where: { id: "version-next" },
      data: { status: "ready" },
      select: { id: true, artifactId: true, version: true },
    });
    expect(tx.artifactVersion.findFirst).toHaveBeenCalledWith({
      where: {
        artifactId: target.artifactId,
        createdByRunId: "run-edit",
        runtimeDraftIndex: 0,
        status: "staging",
      },
      include: { artifact: true },
    });
    expect(tx.artifact.update).toHaveBeenCalledWith({
      where: { id: target.artifactId },
      data: expect.objectContaining({ currentVersionId: "version-next", revision: { increment: 1 } }),
    });
    expect(tx.boardNode.update).toHaveBeenCalledWith({
      where: { id: "node-home" },
      data: expect.objectContaining({ artifactVersionId: "version-next" }),
    });
  });

  it("promotes a PRD v2 revision over a matching v2 base", async () => {
    const { draft, processor, target, tx } = prdRevisionHarness();

    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      draft,
      0,
    )).resolves.toEqual({
      id: "version-prd-next",
      artifactId: target.artifactId,
      version: 2,
    });
    expect(tx.artifactVersion.update).toHaveBeenCalledWith({
      where: { id: "version-prd-next" },
      data: { status: "ready" },
      select: { id: true, artifactId: true, version: true },
    });
  });

  it("rejects a PRD v2 revision when the base schema version differs", async () => {
    const { draft, processor, tx } = prdRevisionHarness(1);

    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      draft,
      0,
    )).rejects.toThrow("RUNTIME_ARTIFACT_REVISION_BASE_INVALID");
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
  });

  it("rejects a PRD revision that replaces the base citations", async () => {
    const { draft, processor, target, tx } = prdRevisionHarness();
    const citation = {
      id: "citation-new",
      documentId: "knowledge-document-new",
      chunkId: "knowledge-chunk-new",
      sourcePath: "knowledge/new.md",
      title: "New source",
      quote: "A source introduced only by the revision.",
      locator: { heading: "New", startLine: 1, endLine: 1 },
    };
    const changedDraft = {
      ...draft,
      citations: [citation],
      content: { ...draft.content, citations: [citation] },
    };

    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      changedDraft,
      0,
    )).rejects.toThrow("RUNTIME_ARTIFACT_REVISION_CITATIONS_INVALID");
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  it("rejects a selected-screen edit that mutates an unselected screen", async () => {
    const changed = prototypeDocument();
    const nextContent = {
      ...changed,
      revision: 2,
      nodes: changed.nodes.map((node) => (
        node.screenId === "screen-success" ? { ...node, name: "illegally-edited-success" } : node
      )),
    };
    const { draft, processor, tx } = revisionHarness(nextContent);
    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      draft,
      0,
    )).rejects.toThrow("RUNTIME_ARTIFACT_REVISION_SCOPE_VIOLATION");
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
  });

  it("rejects a selected-screen edit that mutates shared Prototype variables", async () => {
    const changed = prototypeDocument();
    const nextContent = {
      ...changed,
      revision: 2,
      variables: [{ path: "theme.mode", initialValue: "light" }],
    };
    const { draft, processor, tx } = revisionHarness(nextContent);
    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      draft,
      0,
    )).rejects.toThrow("RUNTIME_ARTIFACT_REVISION_SCOPE_VIOLATION");
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
  });

  it("fails closed when a staged revision asset is quarantined before promotion", async () => {
    const asset = {
      id: "hero-image",
      kind: "image" as const,
      name: "Hero",
      blobId: "blob-hero",
      mediaType: "image/png" as const,
      byteSize: 16,
      sha256: "d".repeat(64),
      width: 320,
      height: 180,
    };
    const baseContent = {
      ...prototypeDocument(),
      assets: [asset],
    };
    const nextContent = {
      ...baseContent,
      revision: 2,
      nodes: baseContent.nodes.map((node) => (
        node.screenId === "screen-home" ? { ...node, name: "edited-home" } : node
      )),
    };
    const { draft, processor, target, tx } = revisionHarness(nextContent);
    tx.artifactVersion.findUnique.mockResolvedValue({
      id: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "ready",
      content: baseContent,
      contentBlobId: null,
      knowledgeReleaseId: null,
      assets: [],
    });
    tx.$queryRaw.mockImplementation(async (query: unknown) => (
      rawSqlText(query).includes('FROM "artifact_version_assets"')
        ? [{
            artifactVersionId: "version-next",
            assetId: asset.id,
            kind: asset.kind,
            blobId: asset.blobId,
            mediaType: asset.mediaType,
            byteSize: BigInt(asset.byteSize),
            sha256: asset.sha256,
            metadata: asset,
            lockedBlobId: asset.blobId,
            blobStatus: "quarantined",
            blobDeletedAt: null,
            blobMediaType: asset.mediaType,
            blobByteSize: BigInt(asset.byteSize),
            blobSha256: asset.sha256,
          }]
        : [{
            id: target.artifactId,
            kind: "prototype",
            currentVersionId: target.artifactVersionId,
          }]
    ));

    await expect(processor.promoteStagedArtifactRevision(
      tx,
      { id: "run-edit", projectId: "project-1", knowledgeReleaseId: null },
      "board-1",
      draft,
      0,
    )).rejects.toThrow("RUNTIME_ARTIFACT_REVISION_ASSET_INVALID");
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.boardNode.update).not.toHaveBeenCalled();
  });
});

describe("Runtime Artifact draft staging and publication", () => {
  const assetSha256 = "e".repeat(64);

  function createDraftFixture() {
    const asset = {
      id: "asset-hero",
      kind: "image" as const,
      name: "Hero image",
      blobId: "blob-hero",
      mediaType: "image/png" as const,
      byteSize: 16,
      sha256: assetSha256,
      width: 1200,
      height: 800,
    };
    const content = { ...prototypeDocument(), assets: [asset] };
    const draft = {
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: "Generated prototype",
      citations: [],
      operation: { kind: "create" as const },
      content,
    };
    const event = {
      type: "artifact.draft" as const,
      artifactIndex: 0,
      sourceEventId: "deerflow:draft-1",
      draft,
      checkpointScreens: content.screens.map(({ id }) => ({
        screenId: id,
        revision: 0,
        checksum: prototypeScreenProjectionChecksum(content, id, 0),
      })),
    };
    const source = {
      position: 0,
      blobId: asset.blobId,
      originalName: "hero.png",
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      original: {
        storageKey: "blobs/hero",
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
      },
      extraction: null,
    };
    return { asset, source, content, draft, event };
  }

  function draftStagingHarness(existing: unknown = null) {
    const fixture = createDraftFixture();
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      attempt: 1,
      request: {
        prompt: "Build it",
        modelId: "quality",
        workflow: "generate",
        generationIntent: null,
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: ["file-1"],
        artifactTargets: [],
        requestedArtifactKinds: ["prototype"],
      },
      knowledgeReleaseId: "knowledge-release-1",
    });
    tx.runtimeAttempt.findUniqueOrThrow.mockResolvedValue({
      id: "runtime-attempt-1",
      runId: "run-1",
      attempt: 1,
      status: "running",
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "generating-ui" } },
    ]);
    const artifact = {
      id: "artifact-new",
      kind: "prototype",
      title: fixture.draft.title,
      currentVersionId: null,
    };
    const createdVersion = {
      id: "version-staged",
      artifactId: artifact.id,
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: fixture.content,
      contentBlobId: null,
      checksum: sha256Canonical(fixture.content),
      citations: [],
      createdByRunId: "run-1",
      runtimeDraftSourceId: fixture.event.sourceEventId,
      runtimeDraftIndex: 0,
      runtimeDraftTitle: fixture.draft.title,
      knowledgeReleaseId: "knowledge-release-1",
      artifact,
    };
    Object.assign(tx, {
      artifact: {
        create: vi.fn(async () => artifact),
        update: vi.fn(),
      },
      artifactVersion: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(async () => createdVersion),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...createdVersion,
          ...(existing as Record<string, unknown> | null),
          ...data,
          artifact,
        })),
      },
      artifactVersionAsset: {
        createMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      boardNode: { create: vi.fn() },
    });
    return { tx, ...processorWithTransaction(tx) };
  }

  function draftCreatedPayload(
    draft: ReturnType<typeof createDraftFixture>["draft"],
    {
      artifactId = "artifact-new",
      artifactVersionId = "version-staged",
      attempt = 1,
      artifactIndex = 0,
    } = {},
  ) {
    return {
      attempt,
      artifactIndex,
      artifactId,
      artifactVersionId,
      kind: draft.kind,
      checksum: sha256Canonical(draft.content),
      draftChecksum: sha256Canonical(draft),
      screens: draft.content.screens.map(({ id, name, route, viewport }) => ({
        id,
        name,
        route,
        viewport,
        revision: 0,
        checksum: prototypeScreenProjectionChecksum(draft.content, id, 0),
      })),
    };
  }

  function createPublicationHarness(
    staged: unknown,
    existingBoardNodes: Array<{
      position: { x: number; y: number };
      size: { width: number; height: number } | null;
    }> = [],
  ) {
    const { content, draft } = createDraftFixture();
    const tx = eventTransaction();
    const binaryAssets = content.assets.filter((asset) => asset.kind !== "icon");
    tx.$queryRaw.mockImplementation(async (query: unknown) => (
      rawSqlText(query).includes('FROM "artifact_version_assets"')
        ? binaryAssets.map((asset) => ({
            artifactVersionId: "version-staged",
            assetId: asset.id,
            kind: asset.kind,
            blobId: asset.blobId,
            mediaType: asset.mediaType,
            byteSize: BigInt(asset.byteSize),
            sha256: asset.sha256,
            metadata: asset,
            lockedBlobId: asset.blobId,
            blobStatus: "ready",
            blobDeletedAt: null,
            blobMediaType: asset.mediaType,
            blobByteSize: BigInt(asset.byteSize),
            blobSha256: asset.sha256,
          }))
        : [{ id: "board-1", status: "running" }]
    ));
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      status: "running",
      attempt: 1,
      projectId: "project-1",
      knowledgeReleaseId: "knowledge-release-1",
      request: {
        prompt: "Build it",
        modelId: "quality",
        workflow: "generate",
        generationIntent: null,
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: ["file-1"],
        artifactTargets: [],
        requestedArtifactKinds: ["prototype"],
      },
    });
    Object.assign(tx, {
      threadEntry: { update: vi.fn(async () => ({})) },
      board: { findUniqueOrThrow: vi.fn(async () => ({ id: "board-1" })) },
      boardNode: {
        findMany: vi.fn(async () => existingBoardNodes),
        aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
        create: vi.fn(async () => ({})),
      },
      artifact: {
        create: vi.fn(),
        update: vi.fn(async () => ({ id: "artifact-new" })),
      },
      artifactVersion: {
        findFirst: vi.fn(async () => staged),
        create: vi.fn(),
        update: vi.fn(async () => ({ id: "version-staged" })),
      },
    });
    return { content, draft, tx, ...processorWithTransaction(tx) };
  }

  it("creates a hidden staging version, pins its assets, and emits the draft event atomically", async () => {
    const { asset, source, content, draft, event } = createDraftFixture();
    const { db, processor, tx } = draftStagingHarness();

    await processor.persistArtifactDraft(
      executionClaim,
      event,
      [source],
      [],
    );

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.artifact.create).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        kind: "prototype",
        title: draft.title,
      },
    });
    expect(tx.artifactVersion.create).toHaveBeenCalledWith({
      data: {
        artifactId: "artifact-new",
        projectId: "project-1",
        version: 1,
        schemaVersion: 1,
        status: "staging",
        content,
        checksum: sha256Canonical(content),
        citations: [],
        createdByRunId: "run-1",
        runtimeDraftSourceId: event.sourceEventId,
        runtimeDraftIndex: 0,
        runtimeDraftTitle: draft.title,
        knowledgeReleaseId: "knowledge-release-1",
      },
      include: {
        artifact: {
          select: { id: true, kind: true, title: true, currentVersionId: true },
        },
      },
    });
    expect(tx.artifactVersionAsset.createMany).toHaveBeenCalledWith({
      data: [{
        artifactVersionId: "version-staged",
        artifactId: "artifact-new",
        projectId: "project-1",
        assetId: asset.id,
        kind: asset.kind,
        blobId: asset.blobId,
        mediaType: asset.mediaType,
        byteSize: 16n,
        sha256: asset.sha256,
        metadata: asset,
      }],
    });
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.boardNode.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run-1",
        sourceId: event.sourceEventId,
        type: "artifact.draft.created",
        payload: {
          attempt: 1,
          artifactIndex: 0,
          artifactId: "artifact-new",
          artifactVersionId: "version-staged",
          kind: "prototype",
          checksum: sha256Canonical(content),
          draftChecksum: sha256Canonical(draft),
          screens: content.screens.map(({ id, name, route, viewport }) => ({
            id,
            name,
            route,
            viewport,
            revision: 0,
            checksum: prototypeScreenProjectionChecksum(content, id, 0),
          })),
        },
      }),
    });
  });

  it("rejects a Prototype draft for a PRD-only Run before staging", async () => {
    const { source, event } = createDraftFixture();
    const { processor, tx } = draftStagingHarness();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      attempt: 1,
      request: {
        prompt: "Generate the requirement document",
        modelId: "quality",
        workflow: "generate",
        generationIntent: null,
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: ["file-1"],
        artifactTargets: [],
        requestedArtifactKinds: ["prd"],
      },
      knowledgeReleaseId: "knowledge-release-1",
    });

    await expect(processor.persistArtifactDraft(
      executionClaim,
      event,
      [source],
      [],
    )).rejects.toThrow("RUNTIME_ARTIFACT_KIND_NOT_REQUESTED");

    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("authorizes a Generate create draft from independently pinned source target assets", async () => {
    const { asset, event } = createDraftFixture();
    const { processor, tx } = draftStagingHarness();
    const sourceTarget = {
      artifactId: "artifact-source",
      artifactVersionId: "version-source",
      screenIds: ["screen-home"],
    };
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      attempt: 1,
      request: {
        prompt: "Generate a new Prototype from the selected screen",
        modelId: "quality",
        workflow: "generate",
        generationIntent: "interactive-prototype",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [sourceTarget],
        requestedArtifactKinds: ["prototype"],
      },
      knowledgeReleaseId: "knowledge-release-1",
    });
    const sourceMetadata = {
      ...asset,
      id: "source-hero",
      name: "Source hero",
    };

    await processor.persistArtifactDraft(
      executionClaim,
      event,
      [],
      [],
      [{
        ...sourceTarget,
        kind: "prototype",
        schemaVersion: 1,
        checksum: sha256Canonical(prototypeDocument()),
        content: { mode: "inline", value: prototypeDocument() },
        assets: [{
          artifactVersionId: sourceTarget.artifactVersionId,
          assetId: sourceMetadata.id,
          kind: sourceMetadata.kind,
          blobId: sourceMetadata.blobId,
          mediaType: sourceMetadata.mediaType,
          byteSize: sourceMetadata.byteSize,
          sha256: sourceMetadata.sha256,
          metadata: sourceMetadata,
          content: {
            storageKey: "tenant/private/source-hero",
            mediaType: sourceMetadata.mediaType,
            byteSize: sourceMetadata.byteSize,
            sha256: sourceMetadata.sha256,
          },
        }],
      }],
    );

    expect(tx.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: "project-1", kind: "prototype" }),
    });
    expect(tx.artifactVersionAsset.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        artifactId: "artifact-new",
        artifactVersionId: "version-staged",
        assetId: asset.id,
        blobId: asset.blobId,
      })],
    });
    expect(tx.artifact.update).not.toHaveBeenCalled();
  });

  it("treats an identical source replay as a no-op without duplicating the draft event", async () => {
    const { source, draft, event } = createDraftFixture();
    const { processor, tx } = draftStagingHarness();

    await processor.persistArtifactDraft(
      executionClaim,
      event,
      [source],
      [],
    );
    tx.runEvent.findFirst.mockResolvedValue({
      type: "artifact.draft.created",
      payload: draftCreatedPayload(draft),
    });
    await processor.persistArtifactDraft(
      executionClaim,
      event,
      [source],
      [],
    );

    expect(tx.artifactVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.artifact.create).toHaveBeenCalledTimes(1);
    expect(tx.artifactVersion.create).toHaveBeenCalledTimes(1);
    expect(tx.artifactVersionAsset.createMany).toHaveBeenCalledTimes(1);
    expect(tx.runEvent.create).toHaveBeenCalledTimes(1);
  });

  it("updates one staging version across checkpoints and ignores an older source replay", async () => {
    const first = createDraftFixture();
    const latestContent = { ...first.content, revision: 2 };
    const latestDraft = { ...first.draft, content: latestContent };
    const latestEvent = {
      ...first.event,
      sourceEventId: "deerflow:draft-2",
      draft: latestDraft,
    };
    const existing = {
      id: "version-staged",
      artifactId: "artifact-new",
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: first.content,
      contentBlobId: null,
      checksum: sha256Canonical(first.content),
      citations: [],
      createdByRunId: "run-1",
      runtimeDraftSourceId: first.event.sourceEventId,
      runtimeDraftIndex: 0,
      runtimeDraftTitle: first.draft.title,
      knowledgeReleaseId: "knowledge-release-1",
      artifact: {
        id: "artifact-new",
        kind: "prototype",
        title: first.draft.title,
        currentVersionId: null,
      },
    };
    const { processor, tx } = draftStagingHarness();
    tx.artifactVersion.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);

    await processor.persistArtifactDraft(
      executionClaim,
      first.event,
      [first.source],
      [],
    );
    await processor.persistArtifactDraft(
      executionClaim,
      latestEvent,
      [first.source],
      [],
    );

    expect(tx.artifact.create).toHaveBeenCalledTimes(1);
    expect(tx.artifactVersion.create).toHaveBeenCalledTimes(1);
    expect(tx.artifactVersion.update).toHaveBeenCalledTimes(1);
    expect(tx.artifactVersion.update).toHaveBeenCalledWith({
      where: { id: "version-staged" },
      data: {
        content: latestContent,
        checksum: sha256Canonical(latestContent),
        citations: [],
      },
      include: {
        artifact: {
          select: { id: true, kind: true, title: true, currentVersionId: true },
        },
      },
    });
    expect(tx.artifactVersionAsset.deleteMany).toHaveBeenCalledWith({
      where: { artifactVersionId: "version-staged" },
    });
    expect(tx.runEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.runEvent.create.mock.calls.map(([call]) => call.data)).toEqual([
      expect.objectContaining({
        sourceId: first.event.sourceEventId,
        payload: draftCreatedPayload(first.draft),
      }),
      expect.objectContaining({
        sourceId: latestEvent.sourceEventId,
        payload: draftCreatedPayload(latestDraft),
      }),
    ]);

    tx.runEvent.findFirst.mockResolvedValue({
      type: "artifact.draft.created",
      payload: draftCreatedPayload(first.draft),
    });
    await processor.persistArtifactDraft(
      executionClaim,
      first.event,
      [first.source],
      [],
    );

    expect(tx.artifactVersion.update).toHaveBeenCalledTimes(1);
    expect(tx.runEvent.create).toHaveBeenCalledTimes(2);
  });

  it("rejects reuse of a source id for different draft content", async () => {
    const { source, content, draft, event } = createDraftFixture();
    const conflictingContent = { ...content, title: "Conflicting content" };
    const { processor, tx } = draftStagingHarness();
    tx.runEvent.findFirst.mockResolvedValue({
      type: "artifact.draft.created",
      payload: draftCreatedPayload(draft),
    });

    await expect(processor.persistArtifactDraft(
      executionClaim,
      { ...event, draft: { ...draft, content: conflictingContent } },
      [source],
      [],
    )).rejects.toThrow("RUNTIME_ARTIFACT_DRAFT_SOURCE_CONFLICT");

    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.artifactVersionAsset.createMany).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("does not stage a draft after the cancellation lock has committed", async () => {
    const { source, event } = createDraftFixture();
    const { processor, tx } = draftStagingHarness();
    rejectExecutionClaim(processor);

    await expect(processor.persistArtifactDraft(
      executionClaim,
      event,
      [source],
      [],
    )).rejects.toThrow("RUNTIME_EXECUTION_FENCED");

    expect(tx.run.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.artifactVersionAsset.createMany).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a Prototype checkpoint before generating-ui is persisted", async () => {
    const { source, event } = createDraftFixture();
    const { processor, tx } = draftStagingHarness();
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "creating-flows" } },
    ]);

    await expect(processor.persistArtifactDraft(
      executionClaim,
      event,
      [source],
      [],
    )).rejects.toThrow("RUNTIME_ARTIFACT_DRAFT_STAGE_TOO_EARLY");

    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a PRD checkpoint before validating-prd is persisted", async () => {
    const draft = runtimePrdResultFixture.artifacts[0]!;
    const event = {
      type: "artifact.draft" as const,
      artifactIndex: 0,
      sourceEventId: "deerflow:early-prd-draft",
      draft,
      checkpointScreens: [],
    };
    const { processor, tx } = draftStagingHarness();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      attempt: 1,
      request: {
        prompt: "Generate the requirement document",
        modelId: "quality",
        workflow: "generate",
        generationIntent: null,
        targetSurface: "web",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [],
        requestedArtifactKinds: ["prd"],
      },
      knowledgeReleaseId: null,
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "drafting-prd" } },
      { payload: { attempt: 1, stage: "structuring-prd" } },
      { payload: { attempt: 1, stage: "collecting-prd-context" } },
      { payload: { attempt: 1, stage: "thinking" } },
    ]);

    await expect(processor.persistArtifactDraft(
      executionClaim,
      event,
      [],
      [],
    )).rejects.toThrow("RUNTIME_ARTIFACT_DRAFT_STAGE_TOO_EARLY");

    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("publishes create output by promoting the same Run/index staging version in place", async () => {
    const fixture = createDraftFixture();
    const staged = {
      id: "version-staged",
      artifactId: "artifact-new",
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: fixture.content,
      checksum: sha256Canonical(fixture.content),
      citations: [],
      runtimeDraftIndex: 0,
      runtimeDraftTitle: fixture.draft.title,
      artifact: {
        id: "artifact-new",
        kind: "prototype",
        currentVersionId: null,
      },
    };
    const { draft, processor, tx } = createPublicationHarness(staged);

    await processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [draft],
    });

    expect(tx.artifactVersion.findFirst).toHaveBeenCalledWith({
      where: {
        createdByRunId: "run-1",
        runtimeDraftIndex: 0,
        status: "staging",
      },
      include: { artifact: true },
    });
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.update).toHaveBeenCalledWith({
      where: { id: "version-staged" },
      data: { status: "ready" },
    });
    expect(tx.artifact.update).toHaveBeenCalledWith({
      where: { id: "artifact-new" },
      data: { title: draft.title, currentVersionId: "version-staged" },
    });
    expect(tx.boardNode.create).toHaveBeenCalledTimes(draft.content.screens.length);
    expect(tx.boardNode.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        boardId: "board-1",
        projectId: "project-1",
        artifactId: "artifact-new",
        artifactVersionId: "version-staged",
        nodeKey: "artifact:artifact-new:screen:screen-home",
      }),
    });
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "artifact.version.created",
        payload: {
          artifactId: "artifact-new",
          artifactVersionId: "version-staged",
          version: 1,
        },
      }),
    });
  });

  it("fails closed when a staged create asset is quarantined before publication", async () => {
    const fixture = createDraftFixture();
    const staged = {
      id: "version-staged",
      artifactId: "artifact-new",
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: fixture.content,
      checksum: sha256Canonical(fixture.content),
      citations: [],
      runtimeDraftIndex: 0,
      runtimeDraftTitle: fixture.draft.title,
      artifact: {
        id: "artifact-new",
        kind: "prototype",
        currentVersionId: null,
      },
    };
    const { draft, content, processor, tx } = createPublicationHarness(staged);
    const asset = content.assets.find((candidate) => candidate.kind !== "icon");
    if (!asset || asset.kind === "icon") throw new Error("fixture asset missing");
    tx.$queryRaw.mockImplementation(async (query: unknown) => (
      rawSqlText(query).includes('FROM "artifact_version_assets"')
        ? [{
            artifactVersionId: "version-staged",
            assetId: asset.id,
            kind: asset.kind,
            blobId: asset.blobId,
            mediaType: asset.mediaType,
            byteSize: BigInt(asset.byteSize),
            sha256: asset.sha256,
            metadata: asset,
            lockedBlobId: asset.blobId,
            blobStatus: "quarantined",
            blobDeletedAt: null,
            blobMediaType: asset.mediaType,
            blobByteSize: BigInt(asset.byteSize),
            blobSha256: asset.sha256,
          }]
        : [{ id: "board-1", status: "running" }]
    ));

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [draft],
    })).rejects.toThrow("RUNTIME_ARTIFACT_CREATE_ASSET_INVALID");

    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.boardNode.create).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("publishes at the persisted Board's actual right edge for non-uniform sparse nodes", async () => {
    const fixture = createDraftFixture();
    const staged = {
      id: "version-staged",
      artifactId: "artifact-new",
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: fixture.content,
      checksum: sha256Canonical(fixture.content),
      citations: [],
      runtimeDraftIndex: 0,
      runtimeDraftTitle: fixture.draft.title,
      artifact: {
        id: "artifact-new",
        kind: "prototype",
        currentVersionId: null,
      },
    };
    const existingBoardNodes = [
      { position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
      { position: { x: 700, y: 50 }, size: { width: 250, height: 200 } },
      { position: { x: 250, y: 700 }, size: { width: 120, height: 90 } },
    ];
    const { draft, processor, tx } = createPublicationHarness(staged, existingBoardNodes);

    await processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [draft],
    });

    expect(tx.boardNode.findMany).toHaveBeenCalledWith({
      where: { boardId: "board-1" },
      select: { position: true, size: true },
    });
    expect(tx.boardNode.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ position: { x: 1_030, y: 0 } }),
    });
    expect(tx.boardNode.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ position: { x: 1_500, y: 0 } }),
    });
  });

  it("fails closed when create publication cannot find its staged draft", async () => {
    const { draft, processor, tx } = createPublicationHarness(null);

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [draft],
    })).rejects.toThrow("RUNTIME_ARTIFACT_DRAFT_MISSING");

    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.boardNode.create).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects final publication when its content differs from the latest staging checkpoint", async () => {
    const fixture = createDraftFixture();
    const staged = {
      id: "version-staged",
      artifactId: "artifact-new",
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: fixture.content,
      checksum: sha256Canonical(fixture.content),
      citations: [],
      runtimeDraftIndex: 0,
      runtimeDraftTitle: fixture.draft.title,
      artifact: {
        id: "artifact-new",
        kind: "prototype",
        currentVersionId: null,
      },
    };
    const { draft, processor, tx } = createPublicationHarness(staged);
    const mismatched = { ...draft, content: { ...draft.content, revision: 2 } };

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [mismatched],
    })).rejects.toThrow("RUNTIME_FINAL_ARTIFACT_DIVERGED");

    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.boardNode.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects final publication when the persisted staging checksum drifts despite unchanged content", async () => {
    const fixture = createDraftFixture();
    const checksum = sha256Canonical(fixture.content);
    const driftedChecksum = `${checksum.startsWith("0") ? "1" : "0"}${checksum.slice(1)}`;
    const staged = {
      id: "version-staged",
      artifactId: "artifact-new",
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "staging",
      content: fixture.content,
      checksum: driftedChecksum,
      citations: [],
      runtimeDraftIndex: 0,
      runtimeDraftTitle: fixture.draft.title,
      artifact: {
        id: "artifact-new",
        kind: "prototype",
        currentVersionId: null,
      },
    };
    const { draft, processor, tx } = createPublicationHarness(staged);

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [draft],
    })).rejects.toThrow("RUNTIME_FINAL_ARTIFACT_DIVERGED");

    expect(draft.content).toEqual(staged.content);
    expect(driftedChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(driftedChecksum).not.toBe(checksum);
    expect(tx.artifactVersion.update).not.toHaveBeenCalled();
    expect(tx.artifact.update).not.toHaveBeenCalled();
    expect(tx.boardNode.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });
});

type ProcessorInternals = {
  prepare(runId: string, approvalIds: string[]): Promise<unknown>;
  recoverPublishedSuccess(runId: string): Promise<{
    runtimeAttemptId: string;
    artifactCount: number;
  } | null>;
  persistProgress(claim: typeof executionClaim, event: {
    type: "phase";
    phase: "generating";
    label: string;
    progress: number | null;
  } | {
    type: "generation.stage";
    stage: "design-system" | "mapping-components";
    sourceEventId: string;
  }): Promise<void>;
  persistDelta(claim: typeof executionClaim, entryId: string, fullText: string, delta: string): Promise<void>;
  waitForInput(claim: typeof executionClaim, input: {
    protocol: "workbench.runtime.input-required.v1";
    approvals: Array<{
      key: string;
      kind: string;
      prompt: string;
      options: [];
    }>;
  }): Promise<void>;
  persistArtifactDraft(
    claim: typeof executionClaim,
    event: {
      type: "artifact.draft";
      artifactIndex: number;
      sourceEventId: string;
      draft: unknown;
      checkpointScreens: Array<{ screenId: string; revision: number; checksum: string }>;
    },
    sources: unknown[],
    designAssets: unknown[],
    artifactTargets?: unknown[],
  ): Promise<void>;
  publishResult(claim: typeof executionClaim, entryId: string, streamedText: string, result: {
    protocol: "workbench.runtime.result.v1";
    message: string;
    artifacts: unknown[];
  }): Promise<void>;
  promoteStagedArtifactRevision(
    tx: unknown,
    run: { id: string; projectId: string; knowledgeReleaseId: string | null },
    boardId: string,
    draft: unknown,
    artifactIndex: number,
  ): Promise<{ id: string; artifactId: string; version: number }>;
  failRun(
    runId: string,
    runtimeAttemptId: string | null,
    error: unknown,
    retryable: boolean,
    claim?: typeof executionClaim | null,
    context?: {
      code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED";
      detailCode: string;
      submissionUnknown: boolean;
    } | null,
  ): Promise<"terminalized" | "fenced">;
  finalizeCancellation(runId: string, reason: string, runtimeAttemptId?: string): Promise<void>;
};

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const frame = (id: string, screenId: string) => ({
    id,
    screenId,
    parentId: null,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: { kind: "literal" as const, value: "#ffffff" },
      stroke: null,
      radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
    kind: "frame" as const,
    childIds: [],
    clipContent: true,
  });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-doc",
    title: "Check-in flow",
    revision: 1,
    screens: [
      { id: "screen-home", name: "Home", route: "/", rootNodeId: "frame-home", initialStateId: null, viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: "frame-success", initialStateId: null, viewport: { width: 390, height: 844 } },
    ],
    nodes: [frame("frame-home", "screen-home"), frame("frame-success", "screen-success")],
    tokens: [],
    assets: [],
    variables: [{ path: "theme.mode", initialValue: "dark" }],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function designAssetSnapshot() {
  return {
    protocol: "workbench.runtime.design-style.v1" as const,
    source: {
      projectId: "project-1",
      artifactId: "artifact-style",
      artifactVersionId: "version-style",
      checksum: "a".repeat(64),
    },
    documentId: "design-main",
    title: "Product UI",
    tokens: [],
    assets: [{
      id: "brand-mark",
      name: "Brand mark",
      kind: "image" as const,
      artifactVersionId: "version-style",
      blobId: "blob-brand",
      mediaType: "image/png",
      byteSize: 16,
      sha256: "d".repeat(64),
    }],
    principles: [],
    guidelines: [],
    components: [],
  };
}

function designPresetSnapshot() {
  const definition = {
    presetId: "workbench.bauhaus",
    version: 1,
    label: "Bauhaus",
    swatch: "#d23b49",
    description: "A geometric product language with direct structure and primary color emphasis.",
    directives: {
      composition: "Use explicit geometric regions with asymmetric but intentional balance.",
      hierarchy: "Use strong scale contrast and color anchors to expose the action order.",
      typography: "Use sturdy geometric typography with concise and functional labels.",
      components: "Expose component structure with crisp borders and simple solid shapes.",
      imagery: "Use diagrammatic imagery and high-contrast crops tied to the layout.",
      interaction: "Make state changes immediate with clear focus and pressed treatments.",
    },
    tokens: {
      colors: {
        canvas: "#f4f1e8",
        surface: "#fffdf7",
        surfaceMuted: "#e4dfd2",
        textPrimary: "#171717",
        textSecondary: "#55514a",
        accent: "#d23b49",
        accentContrast: "#ffffff",
        border: "#171717",
        focus: "#1559a6",
        danger: "#b42318",
      },
      typography: {
        headingFamily: "Futura, sans-serif",
        bodyFamily: "Inter, sans-serif",
        headingWeight: 700,
        bodyWeight: 500,
        baseSizePx: 16,
        lineHeight: 1.4,
      },
      geometry: { cornerRadiusPx: 0, controlRadiusPx: 0, borderWidthPx: 2, controlHeightPx: 42 },
      layout: { density: "compact" as const, spacingUnitPx: 8, contentMaxWidthPx: 1440, gridColumns: 12 },
      motion: { durationFastMs: 80, durationStandardMs: 160, easing: "ease-out" },
    },
  };
  const { presetId, version, ...payload } = definition;
  return {
    protocol: "workbench.runtime.design-preset.v1" as const,
    source: { presetId, version, checksum: sha256Canonical(definition) },
    ...payload,
  };
}

function designAssetRow() {
  return {
    artifactVersionId: "version-style",
    artifactId: "artifact-style",
    projectId: "project-1",
    assetId: "brand-mark",
    kind: "image",
    blobId: "blob-brand",
    mediaType: "image/png",
    byteSize: 16n,
    sha256: "d".repeat(64),
    metadata: {},
    createdAt: now,
    blob: {
      id: "blob-brand",
      sha256: "d".repeat(64),
      storageKey: "blobs/brand",
      mediaType: "image/png",
      byteSize: 16n,
      status: "ready" as const,
      verifiedAt: now,
      gcEligibleAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function eventRun(eventSequence = 1) {
  return {
    id: "run-1",
    projectId: "project-1",
    threadId: "thread-1",
    requestId: "request-1",
    traceId: "trace-1",
    eventSequence,
  };
}

function rawSqlText(query: unknown): string {
  if (!query || typeof query !== "object") return String(query);
  const value = query as { sql?: unknown; text?: unknown; strings?: unknown };
  if (typeof value.sql === "string") return value.sql;
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.strings)) return value.strings.join("");
  return String(query);
}

function eventTransaction() {
  let sequence = 0;
  return {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = rawSqlText(query);
      if (sql.includes('FROM "artifact_version_assets"')) return [];
      if (sql.includes("clock_timestamp()")) return [{ databaseNow: now }];
      if (sql.includes('FROM "runs"')) {
        return [{ status: "cancelling", startedAt: now }];
      }
      if (sql.includes('FROM "runtime_attempts"')) {
        return [{ status: "running", startedAt: now, submissionUnknownAt: null }];
      }
      return [{ id: "board-1", status: "running" }];
    }),
    run: {
      findUniqueOrThrow: vi.fn(async () => ({ status: "running" })),
      update: vi.fn(async () => eventRun(++sequence)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    runEvent: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `event-${String(data.sequence)}`,
        occurredAt: new Date("2026-07-12T00:00:00.000Z"),
        ...data,
      })),
    },
    artifact: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    artifactVersion: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    runDraft: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({})),
    },
    runtimeAttempt: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "runtime-attempt-1", runId: "run-1", status: "running" })),
      findUnique: vi.fn(async () => ({ id: "runtime-attempt-1", runId: "run-1", status: "running", startedAt: now })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    canvasAgentSession: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    canvasToolInvocation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    canvasToolGrant: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    canvasClientCommand: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

function processorWithTransaction(tx: object) {
  const db = {
    $transaction: vi.fn(async (callback: (transaction: object) => unknown) => callback(tx)),
  };
  const prototypePatches = prototypePatchCoordinator();
  const processor = new RunProcessor(
    db as never,
    {} as never,
    noKnowledgeToolGrants(),
    undefined,
    prototypePatches as never,
  );
  Object.assign((processor as unknown as { attempts: object }).attempts, {
    assertClaimTx: vi.fn(async () => ({
      databaseNow: now,
      runStatus: "running",
      attemptStatus: "running",
    })),
  });
  return {
    db,
    prototypePatches,
    processor: processor as unknown as ProcessorInternals,
  };
}

function rejectExecutionClaim(processor: ProcessorInternals) {
  const attempts = (processor as unknown as {
    attempts: { assertClaimTx: ReturnType<typeof vi.fn> };
  }).attempts;
  attempts.assertClaimTx.mockRejectedValueOnce(new Error("RUNTIME_EXECUTION_FENCED"));
}

function publishableRun() {
  return {
    id: "run-1",
    status: "running",
    attempt: 1,
    projectId: "project-1",
    knowledgeReleaseId: null,
    request: {
      prompt: "Build it",
      modelId: "quality",
      workflow: "generate",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: [],
    },
  };
}

function canvasDirectPublishHarness() {
  const tx = eventTransaction() as ReturnType<typeof eventTransaction> & Record<string, any>;
  const baseContent = prototypeDocument();
  const aiContent = {
    ...baseContent,
    revision: 2,
    nodes: baseContent.nodes.map((node) => (
      node.screenId === "screen-home" ? { ...node, name: "ai-edited-home" } : node
    )),
  };
  const target = {
    artifactId: "artifact-target",
    artifactVersionId: "version-base",
    screenIds: ["screen-home"],
  };
  const reference = {
    boardNodeId: "stable-node-home",
    artifactId: target.artifactId,
    artifactVersionId: target.artifactVersionId,
    screenId: "screen-home",
  };
  const result = {
    protocol: "workbench.runtime.result.v1" as const,
    message: "AI and Canvas edits complete",
    artifacts: [{
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: "Updated prototype",
      citations: [],
      operation: { kind: "revise" as const, target },
      content: aiContent,
    }],
  };
  tx.run.findUniqueOrThrow.mockResolvedValue({
    id: "run-1",
    status: "running",
    attempt: 1,
    projectId: "project-1",
    createdById: "principal-1",
    knowledgeReleaseId: null,
    request: {
      prompt: "Edit the selected screen",
      modelId: "quality",
      workflow: "edit",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [target],
      requestedArtifactKinds: ["prototype"],
    },
  });
  tx.canvasAgentSession.findUnique.mockResolvedValue({ id: "canvas-session-1" });
  tx.canvasToolInvocation.findMany.mockResolvedValue([
    canvasMutationInvocation("rename_screen", 1, reference, { target: reference, title: "Agent Home" }),
    canvasMutationInvocation("duplicate_screen", 2, reference, { target: reference }),
  ]);
  tx.$queryRaw = vi.fn()
    .mockResolvedValueOnce([{
      id: "canvas-session-1",
      status: "active",
      boardId: "board-1",
      boardRevision: 3,
      canvasStateRevision: 7,
    }])
    .mockResolvedValueOnce([{ id: "run-1" }])
    .mockResolvedValueOnce([{ id: "board-1" }])
    .mockResolvedValueOnce([{ boardId: null, revision: null }])
    .mockResolvedValueOnce([{ boardId: "board-1", revision: "4" }])
    .mockResolvedValueOnce([{
      id: target.artifactId,
      kind: "prototype",
      currentVersionId: target.artifactVersionId,
    }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ boardId: "", revision: "" }])
    .mockResolvedValueOnce([{ id: "run-1" }]);

  let stagedContent = aiContent;
  let stagedChecksum = sha256Canonical(aiContent);
  const stagedVersion = () => ({
    id: "version-ready",
    artifactId: target.artifactId,
    projectId: "project-1",
    version: 2,
    schemaVersion: 1,
    status: "staging",
    content: stagedContent,
    contentBlobId: null,
    checksum: stagedChecksum,
    citations: [],
    runtimeDraftIndex: 0,
    runtimeDraftTitle: "Updated prototype",
    artifact: {
      id: target.artifactId,
      kind: "prototype",
      currentVersionId: target.artifactVersionId,
    },
    assets: [],
  });
  Object.assign(tx.artifactVersion, {
    findFirst: vi.fn(async () => stagedVersion()),
    findUnique: vi.fn(async () => ({
      id: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId: "project-1",
      version: 1,
      schemaVersion: 1,
      status: "ready",
      content: baseContent,
      contentBlobId: null,
      knowledgeReleaseId: null,
    })),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stagedContent = data.content as typeof aiContent;
      stagedChecksum = data.checksum as string;
      return { count: 1 };
    }),
    update: vi.fn(async () => ({ id: "version-ready", artifactId: target.artifactId, version: 2 })),
  });
  Object.assign(tx.artifact, {
    update: vi.fn(async () => ({ revision: 2 })),
  });
  Object.assign(tx, {
    threadEntry: { update: vi.fn(async () => ({})) },
    board: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "board-1", projectId: "project-1", revision: 3 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    artifactVersionAsset: { createMany: vi.fn(async () => ({ count: 0 })) },
  });
  const targetNodeData = {
    protocol: boardNodeProtocol,
    nodeType: "artifact",
    title: "Agent Home",
    artifactKind: "prototype",
    screenId: "screen-home",
    route: "/",
  };
  Object.assign(tx, {
    boardNode: {
      findMany: vi.fn(async (query: { where: Record<string, unknown> }) => (
        "artifactId" in query.where
          ? [
              { id: "board-node-row-home", data: { screenId: "screen-home" } },
              { id: "board-node-row-success", data: { screenId: "screen-success" } },
            ]
          : [
              { position: { x: 0, y: 0 }, size: { width: 390, height: 844 } },
              { position: { x: 470, y: 0 }, size: { width: 390, height: 844 } },
            ]
      )),
      findUnique: vi.fn(async () => ({
        id: "board-node-row-home",
        boardId: "board-1",
        projectId: "project-1",
        nodeKey: reference.boardNodeId,
        parentNodeKey: null,
        sortOrder: 0,
        kind: "artifact",
        position: { x: 0, y: 0 },
        size: { width: 390, height: 844 },
        artifactId: target.artifactId,
        artifactVersionId: "version-ready",
        data: targetNodeData,
      })),
      aggregate: vi.fn(async () => ({ _max: { sortOrder: 1 } })),
      update: vi.fn(async () => ({})),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-row-id", ...data })),
    },
  });
  tx.canvasToolInvocation.updateMany.mockResolvedValue({ count: 2 });
  const { db, processor, prototypePatches } = processorWithTransaction(tx);
  return { aiContent, db, processor, prototypePatches, reference, result, tx };
}

function canvasMutationInvocation(
  toolName: "quick_edit" | "rename_screen" | "duplicate_screen",
  sequence: number,
  reference: Record<string, string>,
  input: unknown,
) {
  return {
    id: `invocation-${sequence}`,
    sequence,
    toolCallId: `tool-call-${sequence}`,
    toolName,
    requestHash: String(sequence).padStart(64, "0"),
    request: { input },
    satisfiesRunTarget: true,
    targetBoardNodeId: reference.boardNodeId,
    targetArtifactId: reference.artifactId,
    targetArtifactVersionId: reference.artifactVersionId,
    targetScreenId: reference.screenId,
  };
}

function canvasQuickEditPublishHarness(actualBoardRevision = 3) {
  const harness = canvasDirectPublishHarness();
  const { reference, tx } = harness;
  tx.canvasToolInvocation.findMany.mockResolvedValue([
    canvasMutationInvocation("quick_edit", 1, reference, {
      target: reference,
      instruction: "Apply the AI revision",
    }),
  ]);
  tx.canvasToolInvocation.updateMany.mockResolvedValue({ count: 1 });
  tx.$queryRaw.mockReset()
    .mockResolvedValueOnce([{
      id: "canvas-session-1",
      status: "active",
      boardId: "board-1",
      boardRevision: 3,
      canvasStateRevision: 7,
    }])
    .mockResolvedValueOnce([{ id: "board-1" }])
    .mockResolvedValueOnce([{ boardId: null, revision: null }])
    .mockResolvedValueOnce([{ boardId: "board-1", revision: "4" }])
    .mockResolvedValueOnce([{
      id: reference.artifactId,
      kind: "prototype",
      currentVersionId: reference.artifactVersionId,
    }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ boardId: "", revision: "" }])
    .mockResolvedValueOnce([{ id: "run-1" }]);
  tx.board.findUniqueOrThrow.mockReset()
    .mockResolvedValueOnce({ id: "board-1", projectId: "project-1", revision: actualBoardRevision })
    .mockResolvedValueOnce({ revision: actualBoardRevision + 1 });
  tx.board.updateMany.mockResolvedValue({ count: actualBoardRevision === 3 ? 1 : 0 });
  return harness;
}

function pendingCanvasInvocation(
  agentSessionId: string,
  status: "in_flight" | "waiting_client" | "waiting_approval",
) {
  return {
    id: `pending-${agentSessionId}`,
    agentSessionId,
    toolCallId: `tool-call-${agentSessionId}`,
    toolName: "view_screen",
    status,
    boardRevisionBefore: 3,
    boardRevisionAfter: null,
    canvasStateRevisionBefore: 5,
    canvasStateRevisionAfter: null,
  };
}

function expectCanvasInvocationCancelled(
  tx: ReturnType<typeof eventTransaction>,
  invocation: ReturnType<typeof pendingCanvasInvocation>,
) {
  expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith({
    where: { id: invocation.id, status: invocation.status },
    data: {
      status: "cancelled",
      response: expect.objectContaining({
        protocol: "workbench.canvas-agent-tool.v1",
        agentSessionId: invocation.agentSessionId,
        toolCallId: invocation.toolCallId,
        toolName: invocation.toolName,
        status: "cancelled",
        boardRevision: 3,
        canvasStateRevision: 5,
        data: null,
        failure: null,
      }),
      boardRevisionAfter: 3,
      canvasStateRevisionAfter: 5,
      completedAt: expect.any(Date),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
}

describe("Canvas Agent Run lifecycle", () => {
  it("rejects final publication while a Canvas invocation is non-terminal", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue(publishableRun());
    tx.canvasAgentSession.findUnique.mockResolvedValue({ id: "canvas-session-1" });
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: "canvas-session-1", status: "active" }]);
    tx.canvasToolInvocation.findFirst.mockResolvedValueOnce({ id: "invocation-pending" });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [],
    })).rejects.toThrow("CANVAS_TOOL_INVOCATION_PENDING");

    expect(tx.canvasToolInvocation.findFirst).toHaveBeenCalledWith({
      where: {
        agentSessionId: "canvas-session-1",
        status: { in: ["in_flight", "waiting_client", "waiting_approval"] },
      },
      select: { id: true },
    });
    expect(tx.run.findUniqueOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      tx.canvasAgentSession.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.canvasAgentSession.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a succeeded quick_edit that was not bound to the Run target", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue(publishableRun());
    tx.canvasAgentSession.findUnique.mockResolvedValue({ id: "canvas-session-1" });
    tx.$queryRaw
      .mockResolvedValueOnce([{
        id: "canvas-session-1",
        status: "active",
        boardId: "board-1",
        boardRevision: 0,
        canvasStateRevision: 0,
      }]);
    tx.canvasToolInvocation.findMany.mockResolvedValueOnce([{
      id: "quick-edit-unsatisfied",
      sequence: 1,
      toolCallId: "tool-call-quick-edit",
      toolName: "quick_edit",
      requestHash: "a".repeat(64),
      request: {
        input: {
          target: {
            boardNodeId: "node-home",
            artifactId: "artifact-prototype",
            artifactVersionId: "version-prototype",
            screenId: "screen-home",
          },
          instruction: "Change the heading",
        },
      },
      satisfiesRunTarget: false,
      targetBoardNodeId: "node-home",
      targetArtifactId: "artifact-prototype",
      targetArtifactVersionId: "version-prototype",
      targetScreenId: "screen-home",
      createdAt: now,
    }]);
    const { processor } = processorWithTransaction(tx);

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [],
    })).rejects.toThrow("CANVAS_QUICK_EDIT_RUN_TARGET_UNSATISFIED");

    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("completes the session, revokes its grant, and cancels pending commands atomically", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue(publishableRun());
    tx.canvasAgentSession.findUnique.mockResolvedValue({ id: "canvas-session-1" });
    tx.$queryRaw
      .mockResolvedValueOnce([{
        id: "canvas-session-1",
        status: "active",
        boardId: "board-1",
        boardRevision: 0,
        canvasStateRevision: 0,
      }]);
    Object.assign(tx, {
      threadEntry: { update: vi.fn(async () => ({})) },
      board: { findUniqueOrThrow: vi.fn(async () => ({ id: "board-1" })) },
      boardNode: {
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
      },
    });
    const { processor } = processorWithTransaction(tx);

    await processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [],
    });

    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "canvas-session-1", status: "active" },
      data: { status: "completed", activeMutationToolCallId: null },
    });
    expect(tx.canvasToolGrant.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: "canvas-session-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: "canvas-session-1", status: "pending" },
      data: { status: "cancelled" },
    });
  });

  it("publishes ordered direct intents over the AI revision using stable Board nodeKey identity", async () => {
    const { aiContent, processor, prototypePatches, reference, result, tx } = canvasDirectPublishHarness();

    await processor.publishResult(executionClaim, "entry-1", "", result);

    const stagingUpdate = tx.artifactVersion.updateMany.mock.calls[0]?.[0];
    const effectiveContent = stagingUpdate?.data.content;
    expect(effectiveContent.nodes.find((node: { id: string }) => node.id === "frame-home")?.name).toBe("ai-edited-home");
    expect(effectiveContent.screens.find((screen: { id: string }) => screen.id === "screen-home")?.name).toBe("Agent Home");
    expect(effectiveContent.screens).toHaveLength(aiContent.screens.length + 1);
    expect(prototypePatches.synchronizeCheckpointTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        runId: "run-1",
        artifactVersionId: "version-ready",
        document: effectiveContent,
        mode: "trusted_final",
      }),
    );
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run-1",
        sourceId: "system:canvas-direct-intent-checkpoint:1:0",
        type: "artifact.draft.created",
        payload: expect.objectContaining({
          artifactVersionId: "version-ready",
          checksum: sha256Canonical(effectiveContent),
          screens: expect.arrayContaining([
            expect.objectContaining({ id: "screen-home" }),
          ]),
        }),
      }),
    });
    expect(tx.board.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.boardNode.findUnique).toHaveBeenCalledWith({
      where: { boardId_nodeKey: { boardId: "board-1", nodeKey: reference.boardNodeId } },
    });
    const duplicate = tx.boardNode.create.mock.calls[0]?.[0].data;
    expect(duplicate.nodeKey).toMatch(/^canvas:duplicate:/);
    expect(duplicate.nodeKey).not.toBe("board-node-row-home");
    expect(duplicate.artifactVersionId).toBe("version-ready");
    expect(duplicate.data.title).toBe("Agent Home copy");
    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith({
      where: {
        agentSessionId: "canvas-session-1",
        id: { in: ["invocation-1", "invocation-2"] },
        status: "succeeded",
        satisfiesRunTarget: true,
        targetArtifactId: reference.artifactId,
        targetArtifactVersionId: reference.artifactVersionId,
        targetScreenId: reference.screenId,
      },
      data: {
        resultArtifactVersionId: "version-ready",
        boardRevisionAfter: 4,
        canvasStateRevisionAfter: 7,
      },
    });
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "canvas-session-1", status: "active" },
      data: { status: "completed", activeMutationToolCallId: null, boardRevision: 4 },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "run-1",
        status: "running",
        executionOwnerId: executionClaim.ownerId,
        executionEpoch: executionClaim.epoch,
      },
    }));
  });

  it("links quick_edit only when the Board revision is exact", async () => {
    const { processor, reference, result, tx } = canvasQuickEditPublishHarness();

    await processor.publishResult(executionClaim, "entry-1", "", result);

    expect(tx.artifactVersion.updateMany).not.toHaveBeenCalled();
    expect(tx.canvasToolInvocation.updateMany).toHaveBeenCalledWith({
      where: {
        agentSessionId: "canvas-session-1",
        id: { in: ["invocation-1"] },
        status: "succeeded",
        satisfiesRunTarget: true,
        targetArtifactId: reference.artifactId,
        targetArtifactVersionId: reference.artifactVersionId,
        targetScreenId: reference.screenId,
      },
      data: {
        resultArtifactVersionId: "version-ready",
        boardRevisionAfter: 4,
        canvasStateRevisionAfter: 7,
      },
    });
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "canvas-session-1", status: "active" },
      data: { status: "completed", activeMutationToolCallId: null, boardRevision: 4 },
    });
    expect(tx.board.updateMany).toHaveBeenCalledWith({
      where: { id: "board-1", projectId: "project-1", revision: 3 },
      data: { revision: 4 },
    });
  });

  it("rejects quick_edit when the Board has advanced after authorization", async () => {
    const { processor, result, tx } = canvasQuickEditPublishHarness(5);

    await expect(processor.publishResult(executionClaim, "entry-1", "", result))
      .rejects.toThrow("CANVAS_QUICK_EDIT_BOARD_REVISION_INVALID");
    expect(tx.canvasToolInvocation.updateMany).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("does not complete the Run or Canvas session when final intent linkage fails", async () => {
    const { db, processor, result, tx } = canvasDirectPublishHarness();
    tx.canvasToolInvocation.updateMany.mockRejectedValueOnce(new Error("intent linkage failed"));

    await expect(processor.publishResult(
      executionClaim,
      "entry-1",
      "",
      result,
    )).rejects.toThrow("intent linkage failed");

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.canvasAgentSession.updateMany).not.toHaveBeenCalled();
  });

  it("retires the current Canvas capability cycle before waiting for approval", async () => {
    const tx = eventTransaction();
    const pendingInvocation = pendingCanvasInvocation("canvas-session-1", "in_flight");
    tx.run.findUniqueOrThrow.mockResolvedValue({ id: "run-1", status: "running", attempt: 1 });
    tx.canvasAgentSession.findMany.mockResolvedValue([{ id: "canvas-session-1" }]);
    tx.canvasToolInvocation.findMany.mockResolvedValue([pendingInvocation]);
    tx.canvasToolInvocation.updateMany.mockResolvedValue({ count: 1 });
    Object.assign(tx, {
      runApproval: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    });
    const { processor } = processorWithTransaction(tx);

    await processor.waitForInput(executionClaim, {
      protocol: "workbench.runtime.input-required.v1",
      approvals: [],
    });

    expect(tx.canvasAgentSession.findMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        status: "active",
        runtimeAttemptId: "runtime-attempt-1",
      },
      select: { id: true },
    });
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["canvas-session-1"] }, status: "active" },
      data: { status: "cancelled", activeMutationToolCallId: null },
    });
    expectCanvasInvocationCancelled(tx, pendingInvocation);
  });

  it("does not reuse a creation-time Canvas snapshot on an approval-resume attempt", async () => {
    const transaction = vi.fn();
    const issuer = new PrismaCanvasToolGrantIssuer({ $transaction: transaction } as never, null);

    await expect(issuer.issue({
      attempt: 2,
      snapshot: { expired: true },
    } as never)).resolves.toBeNull();

    expect(transaction).not.toHaveBeenCalled();
  });

  it("authorizes snapshot references by stable Board nodeKey, not the database row id", async () => {
    const document = prototypeDocument();
    const reference = {
      boardNodeId: "screen-node-key",
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype",
      screenId: "screen-home",
    };
    const expiresAt = new Date(Date.now() + 60_000);
    const sessionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const tx = {
      $queryRaw: vi.fn(async () => [{ status: "running" }]),
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          projectId: "project-1",
          threadId: "thread-1",
          createdById: "principal-1",
          status: "running",
        })),
      },
      board: {
        findUnique: vi.fn(async () => ({
          id: "board-1",
          projectId: "project-1",
          revision: 7,
          nodes: [{
            id: "database-row-id",
            nodeKey: reference.boardNodeId,
            artifactId: reference.artifactId,
            artifactVersionId: reference.artifactVersionId,
            kind: "artifact",
            data: { nodeType: "artifact", screenId: reference.screenId },
          }],
        })),
      },
      runtimeAttempt: {
        findUnique: vi.fn(async () => ({
          id: "runtime-attempt-1",
          runId: "run-1",
          attempt: 1,
          status: "running",
        })),
      },
      artifactVersion: {
        findMany: vi.fn(async () => [{
          id: reference.artifactVersionId,
          artifactId: reference.artifactId,
          status: "ready",
          content: document,
          contentBlobId: null,
          artifact: { kind: "prototype" },
        }]),
      },
      canvasAgentSession: {
        count: vi.fn(async () => 0),
        findUnique: vi.fn(async () => null),
        create: sessionCreate,
      },
      canvasToolGrant: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          revokedAt: null,
        })),
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const issuer = new PrismaCanvasToolGrantIssuer(db as never, {
      endpoint: "https://workbench.example.com/runtime/canvas/tools/execute",
      secret: Buffer.alloc(32, 7),
      maximumTtlSeconds: 300,
    });

    const scope = {
      runId: "run-1",
      runtimeAttemptId: "runtime-attempt-1",
      attempt: 1,
      principalId: "principal-1",
      projectId: "project-1",
      threadId: "thread-1",
      modelId: "quality",
      workflow: "edit",
      artifactTargets: [{
        artifactId: reference.artifactId,
        artifactVersionId: reference.artifactVersionId,
        screenIds: [reference.screenId],
      }],
      snapshot: {
        protocol: "workbench.canvas-snapshot.v1",
        projectId: "project-1",
        threadId: "thread-1",
        runId: null,
        boardId: "board-1",
        clientSessionId: "canvas-client-1",
        projectSessionGeneration: 1,
        boardRevision: 7,
        canvasStateRevision: 3,
        capturedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: expiresAt.toISOString(),
        viewport: { x: 0, y: 0, zoom: 1 },
        screens: [{
          reference,
          name: "Home",
          route: "/",
          phase: "complete",
          viewport: { width: 390, height: 844 },
        }],
        visibleScreens: [reference],
        selectedScreens: [reference],
      },
    } as const;
    const descriptor = await issuer.issue(scope);

    expect(descriptor?.reference.declaredTools).toContain("quick_edit");
    expect(sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectedNodeIds: [reference.boardNodeId],
        visibleNodeIds: [reference.boardNodeId],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.run.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.runtimeAttempt.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.board.findUnique.mock.invocationCallOrder[0]!,
    );

    vi.clearAllMocks();
    tx.$queryRaw.mockResolvedValueOnce([{ status: "cancelling" }]);
    await expect(issuer.issue(scope)).rejects.toThrow("CANVAS_TOOL_SCOPE_INVALID");
    expect(tx.run.findUnique).not.toHaveBeenCalled();
    expect(tx.runtimeAttempt.findUnique).not.toHaveBeenCalled();
    expect(tx.board.findUnique).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });
});

describe("Artifact canonicalization", () => {
  it("hashes objects independently of key insertion order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
  });

  it("rejects values that cannot be stored as JSON", () => {
    expect(() => canonicalJson(undefined)).toThrow("ARTIFACT_CONTENT_NOT_JSON");
    expect(() => canonicalJson(Number.NaN)).toThrow("ARTIFACT_CONTENT_NOT_JSON");
  });
});

describe("Run durable snapshots", () => {
  it("loads execution-only locators by joining every Design System snapshot pin to its ready Blob", async () => {
    const snapshot = designAssetSnapshot();
    const run = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      designStyleSnapshot: snapshot,
      designStyleSnapshotSha256: sha256Canonical(snapshot),
      status: "running",
      attempt: 1,
      startedAt: now,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "model-1",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "artifact", artifactVersionId: "version-style" },
      },
      sourceSnapshots: [],
      draft: null,
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    const tx = eventTransaction();
    Object.assign(tx.run, { findUnique: vi.fn(async () => run) });
    Object.assign(tx, {
      artifactVersionAsset: { findMany: vi.fn(async () => [designAssetRow()]) },
    });
    const { processor } = processorWithTransaction(tx);

    const prepared = await processor.prepare("run-1", []);

    expect(prepared).toMatchObject({
      designAssets: [{
        assetId: "brand-mark",
        artifactVersionId: "version-style",
        blobId: "blob-brand",
        content: {
          storageKey: "blobs/brand",
          mediaType: "image/png",
          byteSize: 16,
          sha256: "d".repeat(64),
        },
      }],
    });
    expect(tx.artifactVersionAsset.findMany).toHaveBeenCalledWith({
      where: {
        artifactVersionId: "version-style",
        artifactId: "artifact-style",
        projectId: "project-1",
      },
      include: { blob: true },
      orderBy: { assetId: "asc" },
    });
  });

  it("passes an exact materialized preset snapshot without querying Artifact assets", async () => {
    const snapshot = designPresetSnapshot();
    const run = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      designStyleSnapshot: snapshot,
      designStyleSnapshotSha256: sha256Canonical(snapshot),
      status: "running",
      attempt: 1,
      startedAt: now,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "model-1",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "preset", ...snapshot.source },
      },
      sourceSnapshots: [],
      draft: null,
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    const tx = eventTransaction();
    Object.assign(tx.run, { findUnique: vi.fn(async () => run) });
    const findAssets = vi.fn();
    Object.assign(tx, { artifactVersionAsset: { findMany: findAssets } });
    const { processor } = processorWithTransaction(tx);

    const prepared = await processor.prepare("run-1", []);

    expect(prepared).toMatchObject({ designStyleSnapshot: snapshot, designAssets: [] });
    expect(findAssets).not.toHaveBeenCalled();
  });

  it("rejects a preset snapshot whose embedded catalog checksum is not canonical", async () => {
    const valid = designPresetSnapshot();
    const snapshot = { ...valid, source: { ...valid.source, checksum: "0".repeat(64) } };
    const run = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      designStyleSnapshot: snapshot,
      designStyleSnapshotSha256: sha256Canonical(snapshot),
      status: "queued",
      attempt: 0,
      startedAt: null,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "model-1",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "preset", ...snapshot.source },
      },
      sourceSnapshots: [],
      draft: null,
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    const tx = eventTransaction();
    Object.assign(tx.run, { findUnique: vi.fn(async () => run), update: vi.fn() });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.prepare("run-1", [])).rejects.toThrow(
      "RUNTIME_DESIGN_STYLE_SNAPSHOT_INVALID",
    );
    expect(tx.run.update).not.toHaveBeenCalled();
  });

  it("rejects a persisted Design System snapshot whose canonical checksum drifted", async () => {
    const snapshot = {
      protocol: "workbench.runtime.design-style.v1",
      source: {
        projectId: "project-1",
        artifactId: "artifact-style",
        artifactVersionId: "version-style",
        checksum: "a".repeat(64),
      },
      documentId: "design-main",
      title: "Product UI",
      tokens: [],
      assets: [],
      principles: [],
      guidelines: [],
      components: [],
    };
    const run = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      designStyleSnapshot: snapshot,
      designStyleSnapshotSha256: "b".repeat(64),
      status: "queued",
      attempt: 0,
      startedAt: null,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "model-1",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "artifact", artifactVersionId: "version-style" },
      },
      sourceSnapshots: [],
      draft: null,
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    const tx = eventTransaction();
    Object.assign(tx.run, {
      findUnique: vi.fn(async () => run),
      update: vi.fn(),
    });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.prepare("run-1", [])).rejects.toThrow(
      "RUNTIME_DESIGN_STYLE_SNAPSHOT_INVALID",
    );
    expect(tx.run.update).not.toHaveBeenCalled();
  });

  it("stores the initial phase in the same transaction as run.started", async () => {
    const initialRun = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      status: "queued",
      attempt: 0,
      startedAt: null,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "model-1",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
      },
      sourceSnapshots: [],
      draft: null,
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    let sequence = 0;
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockReset();
    Object.assign(tx.run, {
      findUnique: vi.fn(async () => initialRun),
      findUniqueOrThrow: vi.fn(async () => ({
        ...initialRun,
        status: "running",
        attempt: 1,
        phase: "understanding",
        phaseLabel: "正在理解需求",
      })),
      update: vi.fn(async () => eventRun(++sequence)),
    });
    const { db, processor } = processorWithTransaction(tx);

    await processor.prepare("run-1", []);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.run.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "run-1", status: "queued" },
      data: expect.objectContaining({
        status: "running",
        phase: "understanding",
        phaseLabel: "正在理解需求",
        progress: null,
      }),
    }));
    expect(tx.runEvent.create.mock.calls.map(([call]) => call.data.type)).toEqual([
      "run.started",
      "run.generation.stage.changed",
      "run.phase.changed",
    ]);
  });

  it("does not start a queued Run after cancellation wins the state transition", async () => {
    const queuedRun = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      status: "queued",
      attempt: 0,
      startedAt: null,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "quality",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
      },
      sourceSnapshots: [],
      draft: null,
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    const tx = eventTransaction();
    Object.assign(tx.run, {
      findUnique: vi.fn()
        .mockResolvedValueOnce(queuedRun)
        .mockResolvedValueOnce({ status: "cancelling" }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.prepare("run-1", [])).rejects.toThrow("RUNTIME_CANCELLED");

    expect(tx.run.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", status: "queued" },
      data: expect.objectContaining({ status: "running" }),
    }));
    expect(tx.run.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("replays a running run without incrementing its attempt or creating another output entry", async () => {
    const recoveringRun = {
      id: "run-1",
      projectId: "project-1",
      threadId: "thread-1",
      createdById: "principal-1",
      knowledgeReleaseId: null,
      status: "running",
      attempt: 2,
      startedAt: now,
      outputEntryId: "entry-1",
      request: {
        prompt: "Build it",
        modelId: "model-1",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
      },
      sourceSnapshots: [],
      draft: { content: { entryId: "entry-1", text: "partially streamed" } },
      thread: { id: "thread-1", project: { id: "project-1" } },
    };
    const tx = eventTransaction();
    Object.assign(tx.run, {
      findUnique: vi.fn(async () => recoveringRun),
    });
    Object.assign(tx, {
      thread: { update: vi.fn() },
      threadEntry: { create: vi.fn() },
    });
    const { processor } = processorWithTransaction(tx);

    const prepared = await processor.prepare("run-1", []);

    expect(prepared).toMatchObject({
      run: { status: "running", attempt: 2 },
      entryId: "entry-1",
      previousAssistantText: "partially streamed",
    });
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
    expect(tx.threadEntry.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("recovers a committed successful result and its exact RuntimeAttempt", async () => {
    const db = {
      run: {
        findUnique: vi.fn(async () => ({ status: "succeeded", attempt: 2, eventSequence: 9 })),
      },
      runtimeAttempt: {
        findUnique: vi.fn(async () => ({
          id: "runtime-attempt-2",
          runId: "run-1",
          attempt: 2,
          status: "succeeded",
        })),
      },
      runEvent: {
        findMany: vi.fn(async () => [{
          sequence: 9,
          type: "run.completed",
          payload: { artifactCount: 4 },
        }]),
      },
    };
    const processor = new RunProcessor(
      db as never,
      {} as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals;
    vi.spyOn(internals, "prepare").mockResolvedValue(null);
    const onRuntimeAttemptResolved = vi.fn();

    await expect(processor.execute("run-1", [], undefined, undefined, {
      onRuntimeAttemptResolved,
    })).resolves.toEqual({ runId: "run-1", artifactCount: 4 });

    expect(onRuntimeAttemptResolved).toHaveBeenCalledExactlyOnceWith("runtime-attempt-2");
    expect(db.runEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        runId: "run-1",
        type: { in: ["run.completed", "run.failed", "run.cancelled"] },
      },
      take: 2,
    }));
  });

  it("keeps a running run and its attempt non-terminal when a retry remains", async () => {
    const retryableError = new Error("socket closed before the runtime stream completed");
    const runtime = {
      execute: vi.fn(async () => {
        throw retryableError;
      }),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({ status: "running" })),
      },
    };
    const knowledgeToolGrants = noKnowledgeToolGrants();
    const canvasToolGrants = { issue: vi.fn(async () => null) };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      knowledgeToolGrants,
      canvasToolGrants,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
        recordRetryableError: ReturnType<typeof vi.fn>;
      };
    };
    const recordRetryableError = vi.fn(async () => undefined);
    Object.assign(internals, {
      prepare: vi.fn(async () => ({
        run: {
          id: "run-1",
          attempt: 2,
          createdById: "principal-1",
          knowledgeReleaseId: null,
        },
        thread: { id: "thread-1", createdById: "principal-thread-owner" },
        project: { id: "project-1" },
        entryId: "entry-1",
        request: {
          prompt: "Build it",
          modelId: "model-1",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
        },
        sources: [],
        resume: null,
        previousAssistantText: "",
      })),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({
          id: "runtime-attempt-1",
          externalRunId: null,
          lastExternalEventId: null,
        })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "submit",
          providerIdempotencyKey: "wbrt:test-attempt-key",
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
        recordRetryableError,
      },
    });
    const failRun = vi.spyOn(internals, "failRun");

    await expect(processor.execute("run-1", [], undefined, { retryCount: 0, retryLimit: 2 }))
      .rejects.toBe(retryableError);

    expect(recordRetryableError).toHaveBeenCalledWith(executionClaim, {
      code: "RUNTIME_EXECUTION_RETRYABLE",
    });
    expect(knowledgeToolGrants.issue).toHaveBeenCalledWith({
      runId: "run-1",
      runtimeAttemptId: "runtime-attempt-1",
      principalId: "principal-1",
      projectId: "project-1",
      releaseId: null,
    });
    expect(canvasToolGrants.issue).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "principal-1",
      projectId: "project-1",
      threadId: "thread-1",
    }));
    expect(internals.bindings.ensure).toHaveBeenCalledWith("thread-1", {
      workbenchProjectId: "project-1",
      workbenchThreadId: "thread-1",
      workbenchPrincipalId: "principal-thread-owner",
    }, expect.any(AbortSignal));
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      runtimeTransportOwnerId: "principal-binding-owner",
    }), expect.any(Object), expect.any(AbortSignal));
    expect(failRun).not.toHaveBeenCalled();
  });

  it("uses the authoritative post-claim join state and skips new capability grants", async () => {
    const runtime = {
      execute: vi.fn(async () => ({
        protocol: "workbench.runtime.result.v1" as const,
        message: "done",
        artifacts: [],
      })),
    };
    const db = { run: { findUnique: vi.fn(async () => ({ status: "running" })) } };
    const knowledgeToolGrants = noKnowledgeToolGrants();
    const canvasToolGrants = { issue: vi.fn(async () => null) };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      knowledgeToolGrants,
      canvasToolGrants,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
      };
    };
    const publishResult = vi.fn(async () => undefined);
    Object.assign(internals, {
      prepare: vi.fn(async () => durableExecutionPrepared()),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        // This row was read before claim and is intentionally stale.
        ensure: vi.fn(async () => ({
          id: "runtime-attempt-1",
          externalRunId: null,
          lastExternalEventId: null,
        })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "join",
          providerIdempotencyKey: "wbrt:test-attempt-key",
          externalRunId: "external-run-authoritative",
          lastExternalEventId: "provider-event-7",
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
      },
      publishResult,
    });

    const onRuntimeAttemptResolved = vi.fn();
    await expect(processor.execute("run-1", [], undefined, undefined, {
      onRuntimeAttemptResolved,
    })).resolves.toEqual({
      runId: "run-1",
      artifactCount: 0,
    });
    expect(onRuntimeAttemptResolved).toHaveBeenCalledWith("runtime-attempt-1");

    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      runtimeTransportOwnerId: "principal-binding-owner",
      submission: {
        mode: "join",
        providerIdempotencyKey: "wbrt:test-attempt-key",
        externalRunId: "external-run-authoritative",
        lastExternalEventId: "provider-event-7",
      },
      knowledgeTool: null,
      canvasTool: null,
    }), expect.any(Object), expect.any(AbortSignal));
    expect(knowledgeToolGrants.issue).not.toHaveBeenCalled();
    expect(canvasToolGrants.issue).not.toHaveBeenCalled();
  });

  it("advances a returned PRD through validation and publication after Runtime work", async () => {
    const runtime = {
      execute: vi.fn(async () => ({
        protocol: "workbench.runtime.result.v1" as const,
        message: "done",
        artifacts: [{
          kind: "prd" as const,
          schemaVersion: 1 as const,
          title: "Requirements",
          citations: [],
          operation: { kind: "create" as const },
          content: {},
        }],
      })),
    };
    const db = { run: { findUnique: vi.fn(async () => ({ status: "running" })) } };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
      };
    };
    const prepared = durableExecutionPrepared();
    prepared.request.requestedArtifactKinds = ["prd"];
    const persistProgress = vi.fn(async () => undefined);
    const publishResult = vi.fn(async () => undefined);
    Object.assign(internals, {
      prepare: vi.fn(async () => prepared),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({ id: "runtime-attempt-1" })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "submit",
          providerIdempotencyKey: "wbrt:test-attempt-key",
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
      },
      persistProgress,
      publishResult,
    });

    await expect(processor.execute("run-1")).resolves.toEqual({
      runId: "run-1",
      artifactCount: 1,
    });

    expect(persistProgress.mock.calls).toEqual([
      [executionClaim, {
        type: "phase",
        phase: "validating",
        label: "正在校验需求说明书",
        progress: null,
      }],
      [executionClaim, {
        type: "phase",
        phase: "publishing",
        label: "正在发布需求说明书",
        progress: null,
      }],
    ]);
    expect(runtime.execute.mock.invocationCallOrder[0]).toBeLessThan(
      persistProgress.mock.invocationCallOrder[0]!,
    );
    expect(persistProgress.mock.invocationCallOrder[0]).toBeLessThan(
      persistProgress.mock.invocationCallOrder[1]!,
    );
    expect(persistProgress.mock.invocationCallOrder[1]).toBeLessThan(
      publishResult.mock.invocationCallOrder[0]!,
    );
  });

  it("does not enter PRD validation or saving when PRD generation requires input", async () => {
    const runtime = {
      execute: vi.fn(async () => ({
        protocol: "workbench.runtime.input-required.v1" as const,
        approvals: [],
      })),
    };
    const db = { run: { findUnique: vi.fn(async () => ({ status: "running" })) } };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
      };
    };
    const prepared = durableExecutionPrepared();
    prepared.request.requestedArtifactKinds = ["prd"];
    const persistProgress = vi.fn(async () => undefined);
    const waitForInput = vi.fn(async () => undefined);
    const publishResult = vi.fn(async () => undefined);
    Object.assign(internals, {
      prepare: vi.fn(async () => prepared),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({ id: "runtime-attempt-1" })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "submit",
          providerIdempotencyKey: "wbrt:test-attempt-key",
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
      },
      persistProgress,
      waitForInput,
      publishResult,
    });

    await expect(processor.execute("run-1")).resolves.toEqual({
      runId: "run-1",
      approvalCount: 0,
      waitingInput: true,
    });

    expect(persistProgress).not.toHaveBeenCalled();
    expect(waitForInput).toHaveBeenCalledTimes(1);
    expect(publishResult).not.toHaveBeenCalled();
  });

  it("does not write PRD phases for a prototype-only RuntimeResult", async () => {
    const runtime = {
      execute: vi.fn(async () => ({
        protocol: "workbench.runtime.result.v1" as const,
        message: "done",
        artifacts: [{
          kind: "prototype" as const,
          schemaVersion: 1 as const,
          title: "Prototype",
          citations: [],
          operation: { kind: "create" as const },
          content: {},
        }],
      })),
    };
    const db = { run: { findUnique: vi.fn(async () => ({ status: "running" })) } };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
      };
    };
    const prepared = durableExecutionPrepared();
    prepared.request.requestedArtifactKinds = ["prototype"];
    const persistProgress = vi.fn(async () => undefined);
    const publishResult = vi.fn(async () => undefined);
    Object.assign(internals, {
      prepare: vi.fn(async () => prepared),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({ id: "runtime-attempt-1" })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "submit",
          providerIdempotencyKey: "wbrt:test-attempt-key",
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
      },
      persistProgress,
      publishResult,
    });

    await expect(processor.execute("run-1")).resolves.toEqual({
      runId: "run-1",
      artifactCount: 1,
    });

    expect(persistProgress).not.toHaveBeenCalled();
    expect(publishResult).toHaveBeenCalledTimes(1);
  });

  it("keeps reconciliation UNKNOWN and releases it without issuing new grants", async () => {
    const ambiguity = new RuntimeSubmissionUnknownError(
      "RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE",
      { cause: new Error("provider lookup unavailable") },
    );
    const runtime = { execute: vi.fn(async () => Promise.reject(ambiguity)) };
    const db = { run: { findUnique: vi.fn(async () => ({ status: "running" })) } };
    const knowledgeToolGrants = noKnowledgeToolGrants();
    const canvasToolGrants = { issue: vi.fn(async () => null) };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      knowledgeToolGrants,
      canvasToolGrants,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
        markSubmissionUnknown: ReturnType<typeof vi.fn>;
      };
    };
    const markSubmissionUnknown = vi.fn(async () => undefined);
    Object.assign(internals, {
      prepare: vi.fn(async () => durableExecutionPrepared()),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({ id: "runtime-attempt-1" })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "reconcile",
          providerIdempotencyKey: "wbrt:test-attempt-key",
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
        markSubmissionUnknown,
      },
    });
    const failRun = vi.spyOn(internals, "failRun");

    await expect(processor.execute("run-1", [], undefined, {
      retryCount: 99,
      retryLimit: 99,
    })).resolves.toEqual({ runId: "run-1", submissionUnknown: true });

    expect(markSubmissionUnknown).toHaveBeenCalledWith(
      executionClaim,
    );
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      runtimeTransportOwnerId: "principal-binding-owner",
      submission: {
        mode: "reconcile",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      },
    }), expect.any(Object), expect.any(AbortSignal));
    expect(knowledgeToolGrants.issue).not.toHaveBeenCalled();
    expect(canvasToolGrants.issue).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });

  it("persists external event effects before committing the inbox cursor", async () => {
    const persistGate = deferred<void>();
    const cursorCommitted = vi.fn();
    const persistRuntimeEffectsTx = vi.fn(async () => {
      await persistGate.promise;
      return "pending text";
    });
    const publishResult = vi.fn(async () => undefined);
    const runtime = {
      execute: vi.fn(async (_execution: unknown, runtimeObserver: {
        onExternalEvent(
          part: {
            externalRunId: string;
            externalEventId: string;
            event: string;
            payload: Record<string, unknown>;
          },
          effects: Array<{ type: "text.delta"; delta: string }>,
        ): Promise<void>;
      }) => {
        await runtimeObserver.onExternalEvent({
          externalRunId: "external-run-1",
          externalEventId: "event-1",
          event: "messages",
          payload: { delta: "pending text" },
        }, [{ type: "text.delta", delta: "pending text" }]);
        return {
          protocol: "workbench.runtime.result.v1" as const,
          message: "done",
          artifacts: [],
        };
      }),
    };
    const db = {
      run: { findUnique: vi.fn(async () => ({ status: "running" })) },
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals & {
      bindings: { ensure: ReturnType<typeof vi.fn> };
      attempts: {
        ensure: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        submissionContext: ReturnType<typeof vi.fn>;
        providerTextState: ReturnType<typeof vi.fn>;
        processExternalEvent: ReturnType<typeof vi.fn>;
      };
      persistRuntimeEffectsTx: ReturnType<typeof vi.fn>;
    };
    Object.assign(internals, {
      prepare: vi.fn(async () => ({
        run: {
          id: "run-1",
          attempt: 1,
          createdById: "principal-1",
          knowledgeReleaseId: null,
        },
        thread: { id: "thread-1" },
        project: { id: "project-1" },
        entryId: "entry-1",
        request: {
          prompt: "Build it",
          modelId: "model-1",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: [],
        },
        artifactTargets: [],
        sources: [],
        designAssets: [],
        designStyleSnapshot: null,
        resume: null,
        previousAssistantText: "",
      })),
      bindings: {
        ensure: vi.fn(async () => runtimeBindingRecord()),
      },
      attempts: {
        ensure: vi.fn(async () => ({
          id: "runtime-attempt-1",
          externalRunId: "external-run-1",
          lastExternalEventId: null,
        })),
        claim: vi.fn(async () => executionClaim),
        submissionContext: vi.fn(async () => ({
          mode: "join",
          providerIdempotencyKey: "wbrt:test-attempt-key",
          externalRunId: "external-run-1",
          lastExternalEventId: null,
        })),
        executionLivenessClock: vi.fn(async () => ({ databaseNow: now, startedAt: now })),
        providerTextState: vi.fn(async () => emptyProviderTextState()),
        processExternalEvent: vi.fn(async (
          _claim: unknown,
          _part: unknown,
          applyEffects: (tx: object) => Promise<void>,
        ) => {
          await applyEffects({});
          cursorCommitted();
          return { created: true, sequence: 1 };
        }),
      },
      persistRuntimeEffectsTx,
      publishResult,
    });

    const execution = processor.execute("run-1");
    await vi.waitFor(() => expect(persistRuntimeEffectsTx).toHaveBeenCalledWith(
      {},
      executionClaim,
      expect.objectContaining({ entryId: "entry-1" }),
      "",
      [{ type: "text.delta", delta: "pending text" }],
    ));
    expect(cursorCommitted).not.toHaveBeenCalled();
    persistGate.resolve();
    await expect(execution).resolves.toEqual({ runId: "run-1", artifactCount: 0 });

    expect(cursorCommitted).toHaveBeenCalledTimes(1);
    expect(persistRuntimeEffectsTx.mock.invocationCallOrder[0]).toBeLessThan(
      cursorCommitted.mock.invocationCallOrder[0]!,
    );
    expect(publishResult).toHaveBeenCalledTimes(1);
  });

  it("does not finalize local cancellation when cancelling the external run fails", async () => {
    const externalError = new Error("runtime cancellation endpoint unavailable");
    const runtime = {
      cancel: vi.fn(async () => {
        throw externalError;
      }),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "cancelling",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "running",
            externalThreadId: "external-thread-1",
            externalRunId: "external-run-1",
          }],
        })),
      },
      $transaction: vi.fn(),
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
    );
    const internals = processor as unknown as ProcessorInternals;
    Object.assign(internals, {
      attempts: {
        beginCancellation: vi.fn(async () => ({
          id: "runtime-attempt-1",
          status: "cancelling",
          externalThreadId: "external-thread-1",
          externalRunId: "external-run-1",
          startedAt: new Date(),
        })),
        ...providerCancellationOperationStubs("external-run-1"),
      },
    });
    const finalizeCancellation = vi.spyOn(internals, "finalizeCancellation");

    await expect(processor.cancel("run-1")).rejects.toBe(externalError);

    expect(runtime.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeTransportOwnerId: "principal-binding-owner",
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(finalizeCancellation).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("uses the monotonic operation budget when the host wall clock is ahead of PostgreSQL", async () => {
    const runtime = {
      cancel: vi.fn(async () => ({
        disposition: "already_terminal" as const,
        externalRunId: "external-run-1",
        externalStatus: "interrupted",
      })),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "cancelling",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "running",
            externalThreadId: "external-thread-1",
            externalRunId: "external-run-1",
          }],
        })),
      },
    };
    const operationStubs = providerCancellationOperationStubs("external-run-1");
    operationStubs.startProviderCancellationOperation.mockResolvedValue({
      runId: "run-1",
      attemptId: "runtime-attempt-1",
      epoch: 1,
      externalRunId: "external-run-1",
      deadlineAt: new Date(0),
      monotonicDeadlineAtMs: performance.now() + 30_000,
    });
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
    );
    const internals = processor as unknown as ProcessorInternals;
    Object.assign(internals, {
      attempts: {
        beginCancellation: vi.fn(async () => ({
          id: "runtime-attempt-1",
          status: "cancelling",
          externalThreadId: "external-thread-1",
          externalRunId: "external-run-1",
          startedAt: new Date(),
        })),
        ...operationStubs,
      },
    });
    const finalizeCancellation = vi.spyOn(internals, "finalizeCancellation")
      .mockResolvedValue(undefined);

    await expect(processor.cancel("run-1")).resolves.toEqual({
      runId: "run-1",
      cancelled: true,
    });

    expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(operationStubs.settleProviderCancellationOperation).toHaveBeenCalledTimes(1);
    expect(finalizeCancellation).toHaveBeenCalledWith(
      "run-1",
      "Cancelled by user",
      "runtime-attempt-1",
    );
  });

  it("returns control without finalizing when the cancellation provider ignores abort", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      const runtime = {
        cancel: vi.fn(async (
          _scope: unknown,
          _onExternalRunCreated: (externalRunId: string) => Promise<void>,
          signal?: AbortSignal,
        ) => {
          providerSignal = signal;
          return new Promise<never>(() => undefined);
        }),
      };
      const db = {
        run: {
          findUnique: vi.fn(async () => ({
            status: "cancelling",
            createdById: "principal-1",
            runtimeAttempts: [{
              ...runtimeAttemptBinding(),
              id: "runtime-attempt-1",
              status: "running",
              externalThreadId: "external-thread-1",
              externalRunId: "external-run-1",
            }],
          })),
        },
      };
      const processor = new RunProcessor(
        db as never,
        runtime as never,
        noKnowledgeToolGrants(),
        undefined,
        prototypePatchCoordinator() as never,
        undefined,
        { deadlineCancelMs: 900 },
      );
      const internals = processor as unknown as ProcessorInternals;
      Object.assign(internals, {
        attempts: {
          beginCancellation: vi.fn(async () => ({
            id: "runtime-attempt-1",
            status: "cancelling",
            externalThreadId: "external-thread-1",
            externalRunId: "external-run-1",
            startedAt: new Date(),
          })),
          ...providerCancellationOperationStubs("external-run-1"),
        },
      });
      const finalizeCancellation = vi.spyOn(internals, "finalizeCancellation");

      const cancellation = processor.cancel("run-1");
      const observed = cancellation.catch((error: unknown) => error);
      for (let index = 0; index < 10 && runtime.cancel.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(runtime.cancel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(899);
      expect(providerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(observed).resolves.toMatchObject({
        code: "RUNTIME_PROVIDER_CANCEL_TIMEOUT",
        retryable: true,
      });
      expect(providerSignal?.aborted).toBe(false);
      expect(finalizeCancellation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cancellation pending when an external Run may still appear", async () => {
    const attachExternalRun = vi.fn(async (_attemptId, _epoch, externalRunId) => ({
      externalRunId,
      operationCurrent: true,
    }));
    const runtime = {
      cancel: vi.fn(async (
        _scope: unknown,
        onExternalRunCreated: (externalRunId: string) => Promise<void>,
      ) => {
        // The provider races cancellation with submission and reveals the id late.
        await onExternalRunCreated("external-run-late");
        return {
          disposition: "not_found" as const,
          externalRunId: null,
          externalStatus: null,
        };
      }),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "cancelling",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "submitting",
            externalThreadId: "external-thread-1",
            externalRunId: null,
          }],
        })),
      },
      $transaction: vi.fn(),
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
      10_000,
    );
    const internals = processor as unknown as ProcessorInternals;
    Object.assign(internals, {
      attempts: {
        beginCancellation: vi.fn(async () => ({
          id: "runtime-attempt-1",
          status: "cancelling",
          externalThreadId: "external-thread-1",
          externalRunId: null,
          startedAt: new Date(),
        })),
        attachExternalRunForCleanup: attachExternalRun,
        ...providerCancellationOperationStubs(null),
      },
    });
    const finalizeCancellation = vi.spyOn(internals, "finalizeCancellation");

    await expect(processor.cancel("run-1")).rejects.toThrow("RUNTIME_EXTERNAL_RUN_UNRESOLVED");

    expect(attachExternalRun).toHaveBeenCalledWith(
      "runtime-attempt-1",
      1,
      "external-run-late",
    );
    expect(finalizeCancellation).not.toHaveBeenCalled();
  });

  it("keeps unknown external cancellation unresolved after the recovery window", async () => {
    const runtime = {
      cancel: vi.fn(async () => ({
        disposition: "not_found" as const,
        externalRunId: null,
        externalStatus: null,
      })),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "cancelling",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "submitting",
            externalThreadId: "external-thread-1",
            externalRunId: null,
          }],
        })),
      },
      $transaction: vi.fn(),
    };
    const recoveryWindowMs = 10_000;
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      prototypePatchCoordinator() as never,
      recoveryWindowMs,
    );
    const internals = processor as unknown as ProcessorInternals;
    Object.assign(internals, {
      attempts: {
        beginCancellation: vi.fn(async () => ({
          id: "runtime-attempt-1",
          status: "cancelling",
          externalThreadId: "external-thread-1",
          externalRunId: null,
          startedAt: new Date(Date.now() - recoveryWindowMs - 1),
        })),
        ...providerCancellationOperationStubs(null),
      },
    });
    const finalizeCancellation = vi.spyOn(internals, "finalizeCancellation");

    await expect(processor.cancel("run-1")).rejects.toThrow(
      "RUNTIME_EXTERNAL_RUN_UNRESOLVED",
    );
    expect(finalizeCancellation).not.toHaveBeenCalled();
  });

  it("stores runtime phase state before appending its event", async () => {
    const tx = eventTransaction();
    const { db, processor } = processorWithTransaction(tx);

    await processor.persistProgress(executionClaim, {
      type: "phase",
      phase: "generating",
      label: "Generating prototype",
      progress: 0.5,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.run.update).toHaveBeenNthCalledWith(1, {
      where: { id: "run-1" },
      data: {
        phase: "generating",
        phaseLabel: "Generating prototype",
        progress: 0.5,
      },
    });
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.phase.changed",
        payload: {
          phase: "generating",
          label: "Generating prototype",
          progress: 0.5,
        },
      }),
    });
  });

  it("persists trusted generation stages once and updates the coarse Run phase", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "understanding",
      phaseLabel: "Understanding request",
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "thinking" } },
    ]);
    const { processor } = processorWithTransaction(tx);

    await processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "design-system",
      sourceEventId: "deerflow:stage-call-1",
    });

    expect(tx.run.update).toHaveBeenNthCalledWith(1, {
      where: { id: "run-1" },
      data: {
        phase: "planning",
        phaseLabel: "正在生成设计系统",
        progress: null,
      },
    });
    expect(tx.runEvent.create.mock.calls.map(([call]) => call.data)).toEqual([
      expect.objectContaining({
        sourceId: "deerflow:stage-call-1",
        type: "run.generation.stage.changed",
        payload: { attempt: 1, stage: "design-system" },
      }),
      expect.objectContaining({
        sourceId: null,
        type: "run.phase.changed",
      }),
    ]);
  });

  it("persists the ordered PRD stages with one short truthful status each", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "understanding",
      phaseLabel: "正在理解需求",
    });
    const persistedStages = ["thinking"];
    tx.runEvent.findMany.mockImplementation(async () => (
      [...persistedStages].reverse().map((stage) => ({ payload: { attempt: 1, stage } }))
    ));
    const { processor } = processorWithTransaction(tx);
    const stages = [
      ["collecting-prd-context", "retrieving_knowledge", "正在整理项目资料"],
      ["structuring-prd", "planning", "正在规划文档结构"],
      ["drafting-prd", "generating", "正在编写需求说明书"],
      ["validating-prd", "validating", "正在检查需求说明书"],
    ] as const;

    for (const [stage, phase, label] of stages) {
      await processor.persistProgress(executionClaim, {
        type: "generation.stage",
        stage,
        sourceEventId: `deerflow:${stage}`,
      });
      persistedStages.push(stage);
      expect(tx.run.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: { phase, phaseLabel: label, progress: null },
      });
    }
  });

  it("rejects switching between PRD and Prototype stage families", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "retrieving_knowledge",
      phaseLabel: "正在整理项目资料",
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "collecting-prd-context" } },
      { payload: { attempt: 1, stage: "thinking" } },
    ]);
    const { processor } = processorWithTransaction(tx);

    await expect(processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "mapping-components",
      sourceEventId: "deerflow:cross-family-stage",
    })).rejects.toThrow("RUNTIME_GENERATION_STAGE_TRANSITION_INVALID");
  });

  it("treats a persisted generation-stage source replay as a no-op before regression checks", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "generating",
      phaseLabel: "正在生成界面",
    });
    tx.runEvent.findFirst.mockResolvedValue({
      type: "run.generation.stage.changed",
      payload: { attempt: 1, stage: "mapping-components" },
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "generating-ui" } },
    ]);
    const { processor } = processorWithTransaction(tx);

    await expect(processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "mapping-components",
      sourceEventId: "deerflow:persisted-mapping-source",
    })).resolves.toBeUndefined();

    expect(tx.runEvent.findMany).not.toHaveBeenCalled();
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a reused generation-stage source with a different payload", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "planning",
      phaseLabel: "正在映射组件",
    });
    tx.runEvent.findFirst.mockResolvedValue({
      type: "run.generation.stage.changed",
      payload: { attempt: 1, stage: "design-system" },
    });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "mapping-components",
      sourceEventId: "deerflow:reused-stage-source",
    })).rejects.toThrow("RUN_EVENT_SOURCE_CONFLICT");

    expect(tx.runEvent.findMany).not.toHaveBeenCalled();
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a skipped Prototype generation stage", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "understanding",
      phaseLabel: "正在理解需求",
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "thinking" } },
    ]);
    const { processor } = processorWithTransaction(tx);

    await expect(processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "mapping-components",
      sourceEventId: "deerflow:skipped-design-system",
    })).rejects.toThrow("RUNTIME_GENERATION_STAGE_TRANSITION_INVALID");

    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects the same Prototype generation stage from a different source", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "planning",
      phaseLabel: "正在生成设计系统",
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "design-system" } },
      { payload: { attempt: 1, stage: "thinking" } },
    ]);
    const { processor } = processorWithTransaction(tx);

    await expect(processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "design-system",
      sourceEventId: "deerflow:duplicate-design-system",
    })).rejects.toThrow("RUNTIME_GENERATION_STAGE_DUPLICATE");

    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a trusted generation stage regression", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      attempt: 1,
      phase: "generating",
      phaseLabel: "正在生成界面",
    });
    tx.runEvent.findMany.mockResolvedValue([
      { payload: { attempt: 1, stage: "generating-ui" } },
    ]);
    const { processor } = processorWithTransaction(tx);

    await expect(processor.persistProgress(executionClaim, {
      type: "generation.stage",
      stage: "mapping-components",
      sourceEventId: "deerflow:late-call",
    })).rejects.toThrow("RUNTIME_GENERATION_STAGE_REGRESSION");
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("does not append progress after cancellation has committed", async () => {
    const tx = eventTransaction();
    const { processor } = processorWithTransaction(tx);
    rejectExecutionClaim(processor);

    await expect(processor.persistProgress(executionClaim, {
      type: "phase",
      phase: "generating",
      label: "Generating prototype",
      progress: 0.5,
    })).rejects.toThrow("RUNTIME_EXECUTION_FENCED");

    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("does not append message deltas or drafts after cancellation has committed", async () => {
    const tx = eventTransaction();
    const { processor } = processorWithTransaction(tx);
    rejectExecutionClaim(processor);

    await expect(processor.persistDelta(
      executionClaim,
      "entry-1",
      "partial response",
      "response",
    )).rejects.toThrow("RUNTIME_EXECUTION_FENCED");

    expect(tx.runDraft.upsert).not.toHaveBeenCalled();
    expect(tx.run.update).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("does not enter waiting_input or create approvals after cancellation wins", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({ status: "running", attempt: 1 });
    Object.assign(tx.run, {
      findUnique: vi.fn(async () => ({ status: "cancelling" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    });
    Object.assign(tx, {
      runApproval: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
    });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.waitForInput(executionClaim, {
      protocol: "workbench.runtime.input-required.v1",
      approvals: [{ key: "scope", kind: "choice", prompt: "Choose scope", options: [] }],
    })).rejects.toThrow("RUNTIME_CANCELLED");

    expect(tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.runApproval.findUnique).not.toHaveBeenCalled();
    expect(tx.runApproval.create).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("stores progress 1 when publishing a successful result", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      status: "running",
      projectId: "project-1",
      knowledgeReleaseId: null,
      request: {
        prompt: "Build it",
        modelId: "quality",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [],
        requestedArtifactKinds: [],
      },
    });
    Object.assign(tx, {
      threadEntry: { update: vi.fn(async () => ({})) },
      board: { findUniqueOrThrow: vi.fn(async () => ({ id: "board-1" })) },
      boardNode: {
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
      },
    });
    const { processor } = processorWithTransaction(tx);

    await processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [],
    });

    expect(tx.run.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "run-1",
        status: "running",
        executionOwnerId: executionClaim.ownerId,
        executionEpoch: executionClaim.epoch,
      },
      data: expect.objectContaining({
        status: "succeeded",
        progress: 1,
        errorRetryable: null,
      }),
    });
    expect(tx.runtimeAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: "runtime-attempt-1",
        runId: "run-1",
        status: "running",
        executionOwnerId: executionClaim.ownerId,
        executionEpoch: executionClaim.epoch,
      },
      data: expect.objectContaining({ status: "succeeded" }),
    });
  });

  it("does not emit completion events after cancellation wins the publication fence", async () => {
    const tx = eventTransaction();
    tx.run.findUniqueOrThrow.mockResolvedValue({
      id: "run-1",
      status: "running",
      projectId: "project-1",
      knowledgeReleaseId: null,
      request: {
        prompt: "Build it",
        modelId: "quality",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [],
        requestedArtifactKinds: [],
      },
    });
    Object.assign(tx.run, {
      findUnique: vi.fn(async () => ({ status: "cancelling" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    });
    Object.assign(tx, {
      threadEntry: { update: vi.fn(async () => ({})) },
      board: { findUniqueOrThrow: vi.fn(async () => ({ id: "board-1" })) },
      boardNode: {
        findMany: vi.fn(async () => []),
        aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
      },
    });
    const { processor } = processorWithTransaction(tx);

    await expect(processor.publishResult(executionClaim, "entry-1", "", {
      protocol: "workbench.runtime.result.v1",
      message: "Done",
      artifacts: [],
    })).rejects.toThrow("RUNTIME_CANCELLED");

    expect(tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.runEvent.create).not.toHaveBeenCalled();
  });

  it("stores failure state and removes staging versions without deleting a revise target", async () => {
    const tx = eventTransaction();
    const pendingInvocation = pendingCanvasInvocation("canvas-session-failed", "waiting_client");
    tx.canvasAgentSession.findMany.mockResolvedValue([{ id: "canvas-session-failed" }]);
    tx.canvasToolInvocation.findMany.mockResolvedValue([pendingInvocation]);
    tx.canvasToolInvocation.updateMany.mockResolvedValue({ count: 1 });
    tx.artifactVersion.findMany.mockResolvedValue([
      { id: "version-create-staging", artifactId: "artifact-create", artifact: { currentVersionId: null } },
      {
        id: "version-revise-staging",
        artifactId: "artifact-revise",
        artifact: { currentVersionId: "version-ready" },
      },
    ]);
    tx.artifactVersion.deleteMany.mockResolvedValue({ count: 2 });
    tx.artifact.deleteMany.mockResolvedValue({ count: 1 });
    const { db, processor } = processorWithTransaction(tx);

    await processor.failRun("run-1", "runtime-attempt-1", new Error("runtime unavailable"), false);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: { in: ["queued", "running"] } },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "RUNTIME_EXECUTION_FAILED",
        errorDetail: "RUNTIME_EXECUTION_FAILED",
        errorRetryable: false,
      }),
    });
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.failed",
        payload: {
          code: "RUNTIME_EXECUTION_FAILED",
          message: "RUNTIME_EXECUTION_FAILED",
          retryable: false,
        },
      }),
    });
    expect(tx.runtimeAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "runtime-attempt-1" },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "RUNTIME_EXECUTION_FAILED",
        errorDetail: "RUNTIME_EXECUTION_FAILED",
        errorRetryable: false,
      }),
    });
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["canvas-session-failed"] }, status: "active" },
      data: { status: "cancelled", activeMutationToolCallId: null },
    });
    expect(tx.canvasToolGrant.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: { in: ["canvas-session-failed"] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: { in: ["canvas-session-failed"] }, status: "pending" },
      data: { status: "cancelled" },
    });
    expectCanvasInvocationCancelled(tx, pendingInvocation);
    expect(tx.artifactVersion.findMany).toHaveBeenCalledWith({
      where: {
        createdByRunId: "run-1",
        status: "staging",
        runtimeDraftSourceId: { not: null },
        runtimeDraftIndex: { not: null },
        runtimeDraftTitle: { not: null },
      },
      select: {
        id: true,
        artifactId: true,
        artifact: { select: { currentVersionId: true } },
      },
    });
    expect(tx.artifactVersion.deleteMany).toHaveBeenCalledWith({
      where: {
        createdByRunId: "run-1",
        status: "staging",
        runtimeDraftSourceId: { not: null },
        runtimeDraftIndex: { not: null },
        runtimeDraftTitle: { not: null },
        id: { in: ["version-create-staging", "version-revise-staging"] },
      },
    });
    expect(tx.artifact.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["artifact-create"] },
        currentVersionId: null,
        versions: { none: {} },
        boardNodes: { none: {} },
        designSystemImports: { none: {} },
        designSystemCreations: { none: {} },
        versionEditReceipts: { none: {} },
        creationReceipt: null,
      },
    });
    expect(tx.runDraft.deleteMany).toHaveBeenCalledWith({ where: { runId: "run-1" } });
  });

  it("persists an unconfirmed provider cancellation as a failed Run with UNKNOWN evidence", async () => {
    const tx = eventTransaction();
    tx.runtimeAttempt.findUnique.mockResolvedValue({
      id: "runtime-attempt-1",
      runId: "run-1",
      status: "submitting",
      startedAt: now,
      submissionUnknownAt: null,
    });
    const { processor } = processorWithTransaction(tx);
    const liveness = new RuntimeLivenessError("RUNTIME_PROVIDER_SUBMISSION_TIMEOUT", true);

    await processor.failRun(
      "run-1",
      "runtime-attempt-1",
      liveness,
      true,
      executionClaim,
      {
        code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        detailCode: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
        submissionUnknown: true,
      },
    );

    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        executionOwnerId: executionClaim.ownerId,
        executionEpoch: executionClaim.epoch,
      },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        errorDetail: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
        errorRetryable: true,
        executionOwnerId: null,
        executionHeartbeatAt: null,
        executionLeaseExpiresAt: null,
      }),
    });
    expect(tx.runtimeAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: "runtime-attempt-1",
        runId: "run-1",
        executionOwnerId: executionClaim.ownerId,
        executionEpoch: executionClaim.epoch,
      },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
        errorDetail: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
        errorRetryable: true,
        submissionUnknownAt: expect.any(Date),
        executionOwnerId: null,
        executionHeartbeatAt: null,
        executionLeaseExpiresAt: null,
      }),
    });
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.failed",
        payload: {
          code: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
          message: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
          retryable: true,
        },
      }),
    });
    expect(tx.runEvent.create.mock.calls.some(
      ([{ data }]) => data.type === "run.cancelled",
    )).toBe(false);
  });

  it("stores cancellation and removes the Run's staging version and temporary Artifact", async () => {
    const tx = eventTransaction();
    const pendingInvocation = pendingCanvasInvocation("canvas-session-cancelled", "waiting_approval");
    tx.canvasAgentSession.findMany.mockResolvedValue([{ id: "canvas-session-cancelled" }]);
    tx.canvasToolInvocation.findMany.mockResolvedValue([pendingInvocation]);
    tx.canvasToolInvocation.updateMany.mockResolvedValue({ count: 1 });
    tx.artifactVersion.findMany.mockResolvedValue([
      {
        id: "version-cancelled-staging",
        artifactId: "artifact-cancelled-create",
        artifact: { currentVersionId: null },
      },
    ]);
    tx.artifactVersion.deleteMany.mockResolvedValue({ count: 1 });
    tx.artifact.deleteMany.mockResolvedValue({ count: 1 });
    const { db, processor } = processorWithTransaction(tx);

    await processor.finalizeCancellation(
      "run-1",
      "Cancelled before publishing",
      "runtime-attempt-1",
    );

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "cancelling" },
      data: expect.objectContaining({
        status: "cancelled",
        cancellationReason: "Cancelled before publishing",
        errorCode: null,
        errorDetail: null,
        errorRetryable: null,
        executionOwnerId: null,
        executionHeartbeatAt: null,
        executionLeaseExpiresAt: null,
      }),
    });
    expect(tx.runtimeAttempt.update).toHaveBeenCalledWith({
      where: { id: "runtime-attempt-1" },
      data: expect.objectContaining({
        status: "cancelled",
        errorCode: null,
        errorDetail: null,
        errorRetryable: null,
        executionOwnerId: null,
        executionHeartbeatAt: null,
        executionLeaseExpiresAt: null,
      }),
    });
    expect(tx.runEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "run.cancelled",
        payload: { reason: "Cancelled before publishing" },
      }),
    });
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["canvas-session-cancelled"] }, status: "active" },
      data: { status: "cancelled", activeMutationToolCallId: null },
    });
    expect(tx.canvasToolGrant.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: { in: ["canvas-session-cancelled"] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: { in: ["canvas-session-cancelled"] }, status: "pending" },
      data: { status: "cancelled" },
    });
    expectCanvasInvocationCancelled(tx, pendingInvocation);
    expect(tx.artifactVersion.deleteMany).toHaveBeenCalledWith({
      where: {
        createdByRunId: "run-1",
        status: "staging",
        runtimeDraftSourceId: { not: null },
        runtimeDraftIndex: { not: null },
        runtimeDraftTitle: { not: null },
        id: { in: ["version-cancelled-staging"] },
      },
    });
    expect(tx.artifact.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["artifact-cancelled-create"] },
        currentVersionId: null,
        versions: { none: {} },
        boardNodes: { none: {} },
        designSystemImports: { none: {} },
        designSystemCreations: { none: {} },
        versionEditReceipts: { none: {} },
        creationReceipt: null,
      },
    });
  });

  it("maps immutable source snapshots to ordered private content locators", () => {
    const originalSha = "a".repeat(64);
    const textSha = "b".repeat(64);
    const structuredSha = "c".repeat(64);
    const sourceChecksum = "f".repeat(64);
    const blob = (overrides: Record<string, unknown>) => ({
      id: "blob",
      sha256: originalSha,
      storageKey: "blobs/original",
      mediaType: "application/pdf",
      byteSize: 12n,
      status: "ready" as const,
      verifiedAt: now,
      gcEligibleAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
    const sources = mapRuntimeSources([{
      id: "snapshot-1",
      runId: "run-1",
      projectId: "project-1",
      position: 0,
      sourceId: "source-1",
      kind: "file",
      label: "brief.pdf",
      checksum: sourceChecksum,
      descriptor: {},
      snapshot: {},
      createdAt: now,
      source: {
        id: "source-1",
        projectId: "project-1",
        kind: "file",
        checksum: sourceChecksum,
        blobs: [{
          position: 0,
          blobId: "blob-original",
          fileAssetId: "file-1",
          role: "primary",
          path: "brief.pdf",
          mediaType: "application/pdf",
          byteSize: 12n,
          sha256: originalSha,
          blob: blob({ id: "blob-original" }),
          fileAsset: {
            currentExtraction: {
              id: "extraction-1",
              fileAssetId: "file-1",
              sourceBlobId: "blob-original",
              attempt: 1,
              status: "ready" as const,
              parser: "docling",
              parserVersion: "1",
              outputSchemaVersion: 1,
              idempotencyKey: "extract:key",
              requestHash: "d".repeat(64),
              contentSha256: textSha,
              failureCode: null,
              failureDetail: null,
              metadata: null,
              startedAt: now,
              finishedAt: now,
              createdAt: now,
              updatedAt: now,
              outputs: [
                {
                  extractionId: "extraction-1",
                  kind: "structured",
                  position: 0,
                  blobId: "blob-structured",
                  metadata: null,
                  createdAt: now,
                  blob: blob({
                    id: "blob-structured",
                    sha256: structuredSha,
                    storageKey: "blobs/structured",
                    mediaType: "application/json",
                    byteSize: 20n,
                  }),
                },
                {
                  extractionId: "extraction-1",
                  kind: "text",
                  position: 0,
                  blobId: "blob-text",
                  metadata: null,
                  createdAt: now,
                  blob: blob({
                    id: "blob-text",
                    sha256: textSha,
                    storageKey: "blobs/text",
                    mediaType: "text/markdown",
                    byteSize: 30n,
                  }),
                },
              ],
            },
          },
        }],
      },
    }] as never);

    expect(sources).toEqual([{
      position: 0,
      sourceId: "source-1",
      sourceKind: "file",
      blobId: "blob-original",
      originalName: "brief.pdf",
      mediaType: "application/pdf",
      byteSize: 12,
      sha256: originalSha,
      original: {
        storageKey: "blobs/original",
        mediaType: "application/pdf",
        byteSize: 12,
        sha256: originalSha,
      },
      extraction: {
        kind: "text",
        position: 0,
        content: {
          storageKey: "blobs/text",
          mediaType: "text/markdown",
          byteSize: 30,
          sha256: textSha,
        },
      },
    }]);
  });

  it("pins Prototype binary assets only when they exactly match a verified Run source", () => {
    const sha256 = "d".repeat(64);
    const content = {
      ...prototypeDocument(),
      assets: [{
        id: "hero-image",
        kind: "image" as const,
        name: "Hero",
        blobId: "blob-image",
        mediaType: "image/png" as const,
        byteSize: 16,
        sha256,
        width: 320,
        height: 180,
      }],
    };
    const draft = {
      kind: "prototype" as const,
      schemaVersion: 1 as const,
      title: "Prototype",
      citations: [],
      operation: { kind: "create" as const },
      content,
    };
    const source = {
      position: 0,
      blobId: "blob-image",
      originalName: "hero.png",
      mediaType: "image/png",
      byteSize: 16,
      sha256,
      original: {
        storageKey: "blobs/hero",
        mediaType: "image/png",
        byteSize: 16,
        sha256,
      },
      extraction: null,
    };

    expect(prototypeAssetPins(draft, [source])).toEqual([{
      assetId: "hero-image",
      kind: "image",
      blobId: "blob-image",
      mediaType: "image/png",
      byteSize: 16,
      sha256,
      metadata: content.assets[0],
    }]);
    expect(() => prototypeAssetPins(draft, [{ ...source, sha256: "e".repeat(64) }]))
      .toThrow("RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:hero-image");
    expect(() => prototypeAssetPins(draft, []))
      .toThrow("RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:hero-image");

    const designAsset = {
      assetId: "source-hero",
      name: "Source hero",
      kind: "image" as const,
      artifactVersionId: "version-style",
      blobId: "blob-image",
      mediaType: "image/png",
      byteSize: 16,
      sha256,
      content: {
        storageKey: "blobs/design-hero",
        mediaType: "image/png",
        byteSize: 16,
        sha256,
      },
    };
    expect(prototypeAssetPins(draft, [], [designAsset])).toEqual([{
      assetId: "hero-image",
      kind: "image",
      blobId: "blob-image",
      mediaType: "image/png",
      byteSize: 16,
      sha256,
      metadata: content.assets[0],
    }]);
    expect(() => prototypeAssetPins(draft, [], [{ ...designAsset, blobId: "blob-other" }]))
      .toThrow("RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:hero-image");
    expect(() => prototypeAssetPins(draft, [], [{ ...designAsset, kind: "font" }]))
      .toThrow("RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:hero-image");

    const sourceAsset = {
      artifactVersionId: "version-source",
      assetId: content.assets[0]!.id,
      kind: content.assets[0]!.kind,
      blobId: content.assets[0]!.blobId,
      mediaType: content.assets[0]!.mediaType,
      byteSize: content.assets[0]!.byteSize,
      sha256: content.assets[0]!.sha256,
      metadata: content.assets[0]!,
      content: {
        storageKey: "tenant/private/source-hero",
        mediaType: content.assets[0]!.mediaType,
        byteSize: content.assets[0]!.byteSize,
        sha256: content.assets[0]!.sha256,
      },
    };
    const renamedDraft = {
      ...draft,
      content: {
        ...draft.content,
        assets: [{ ...content.assets[0]!, id: "generated-hero", name: "Generated hero" }],
      },
    };
    expect(prototypeAssetPins(renamedDraft, [], [], [], [sourceAsset])).toMatchObject([{
      assetId: "generated-hero",
      blobId: "blob-image",
      metadata: { name: "Generated hero", width: 320, height: 180 },
    }]);
    expect(() => prototypeAssetPins({
      ...renamedDraft,
      content: {
        ...renamedDraft.content,
        assets: [{ ...renamedDraft.content.assets[0]!, width: 321 }],
      },
    }, [], [], [], [sourceAsset])).toThrow("RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:generated-hero");
    expect(() => prototypeAssetPins(renamedDraft, [], [], [], [{
      ...sourceAsset,
      metadata: { ...sourceAsset.metadata, blobId: "blob-forged" },
    }])).toThrow("RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:generated-hero");
  });

  it("rejects missing, drifted, deleted, or unavailable Design System asset sources", () => {
    const snapshot = designAssetSnapshot();
    const row = designAssetRow();

    expect(() => mapRuntimeDesignAssets(snapshot, [])).toThrow(
      "RUNTIME_DESIGN_STYLE_ASSET_PIN_MISMATCH",
    );
    expect(() => mapRuntimeDesignAssets(snapshot, [{ ...row, sha256: "e".repeat(64) }]))
      .toThrow("RUNTIME_DESIGN_STYLE_ASSET_SOURCE_INVALID:brand-mark");
    expect(() => mapRuntimeDesignAssets(snapshot, [{
      ...row,
      blob: { ...row.blob, status: "quarantined" as const },
    }])).toThrow("RUNTIME_DESIGN_STYLE_ASSET_SOURCE_INVALID:brand-mark");
    expect(() => mapRuntimeDesignAssets(snapshot, [{
      ...row,
      blob: { ...row.blob, deletedAt: now },
    }])).toThrow("RUNTIME_DESIGN_STYLE_ASSET_SOURCE_INVALID:brand-mark");
    expect(() => mapRuntimeDesignAssets(snapshot, [{
      ...row,
      blob: { ...row.blob, mediaType: "image/jpeg" },
    }])).toThrow("RUNTIME_DESIGN_STYLE_ASSET_SOURCE_INVALID:brand-mark");
  });

  it("rejects source snapshots with gaps or unavailable blobs", () => {
    const sourceChecksum = "f".repeat(64);
    const row = {
      id: "snapshot-1",
      runId: "run-1",
      projectId: "project-1",
      position: 1,
      sourceId: "source-1",
      kind: "file" as const,
      label: "brief.txt",
      checksum: sourceChecksum,
      descriptor: {},
      snapshot: {},
      createdAt: now,
      source: {
        id: "source-1",
        projectId: "project-1",
        kind: "file" as const,
        checksum: sourceChecksum,
        blobs: [{
          position: 0,
          blobId: "blob-1",
          fileAssetId: "file-1",
          role: "primary",
          path: "brief.txt",
          mediaType: "text/plain",
          byteSize: 4n,
          sha256: "a".repeat(64),
          blob: {
            id: "blob-1",
            sha256: "a".repeat(64),
            storageKey: "blobs/one",
            mediaType: "text/plain",
            byteSize: 4n,
            status: "ready" as const,
            verifiedAt: now,
            gcEligibleAt: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          fileAsset: null,
        }],
      },
    };
    expect(() => mapRuntimeSources([row] as never)).toThrow("RUNTIME_SOURCE_ORDER_INVALID");
    expect(() => mapRuntimeSources([{
      ...row,
      position: 0,
      source: {
        ...row.source,
        blobs: [{ ...row.source.blobs[0]!, blob: { ...row.source.blobs[0]!.blob, status: "deleted" as const } }],
      },
    }] as never)).toThrow("RUNTIME_SOURCE_BLOB_INVALID");
    expect(() => mapRuntimeSources([{
      ...row,
      position: 0,
      source: {
        ...row.source,
        blobs: [{ ...row.source.blobs[0]!, blob: { ...row.source.blobs[0]!.blob, status: "quarantined" as const } }],
      },
    }] as never)).toThrow("RUNTIME_SOURCE_BLOB_INVALID");
  });
});

describe("Provider cancellation convergence", () => {
  afterEach(() => vi.useRealTimers());

  it("converges an already-terminal provider Run without restoring runtime execution", async () => {
    const resolution = providerCancellationResolutionHarness();
    const runtime = {
      cancel: vi.fn(async () => ({
        disposition: "already_terminal" as const,
        externalRunId: "external-run-1",
        externalStatus: "success",
      })),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "failed",
          errorCode: runtimeProviderCancellationUnconfirmedCode,
          errorDetail: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "failed",
            errorCode: runtimeProviderCancellationUnconfirmedCode,
            externalThreadId: "external-thread-1",
            externalRunId: "external-run-1",
            startedAt: now,
            providerCancellationResolution: null,
          }],
        })),
      },
      $transaction: resolution.transaction,
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
    );

    await expect(processor.cancel("run-1")).resolves.toEqual({
      runId: "run-1",
      cancelled: false,
      cancellationConverged: true,
    });
    expect(runtime.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        runtimeAttemptId: "runtime-attempt-1",
        runtimeTransportOwnerId: "principal-binding-owner",
        externalRunId: "external-run-1",
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(resolution.create).toHaveBeenCalledWith({
      data: {
        runtimeAttemptId: "runtime-attempt-1",
        runId: "run-1",
        operationEpoch: 1,
        externalRunId: "external-run-1",
        failureCode: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
        outcome: "already_terminal",
      },
    });
  });

  it("keeps a failed Run pending while provider absence is still within the recovery window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recoveryWindowMs = 10_000;
    const resolution = providerCancellationResolutionHarness(
      null,
      "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
    );
    const runtime = {
      cancel: vi.fn(async () => ({
        disposition: "not_found" as const,
        externalRunId: null,
        externalStatus: null,
      })),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "failed",
          errorCode: runtimeProviderCancellationUnconfirmedCode,
          errorDetail: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "failed",
            errorCode: runtimeProviderCancellationUnconfirmedCode,
            externalThreadId: "external-thread-1",
            externalRunId: null,
            startedAt: new Date(now.getTime() - recoveryWindowMs + 1),
            providerCancellationResolution: null,
          }],
        })),
      },
      $transaction: resolution.transaction,
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      undefined,
      recoveryWindowMs,
    );

    await expect(processor.cancel("run-1")).rejects.toThrow(
      runtimeProviderCancellationUnconfirmedCode,
    );
    expect(resolution.create).not.toHaveBeenCalled();
  });

  it("keeps a failed Run unresolved at the external Run recovery-window boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recoveryWindowMs = 10_000;
    const resolution = providerCancellationResolutionHarness(
      null,
      "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
    );
    const runtime = {
      cancel: vi.fn(async () => ({
        disposition: "not_found" as const,
        externalRunId: null,
        externalStatus: null,
      })),
    };
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "failed",
          errorCode: runtimeProviderCancellationUnconfirmedCode,
          errorDetail: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
          createdById: "principal-1",
          runtimeAttempts: [{
            ...runtimeAttemptBinding(),
            id: "runtime-attempt-1",
            status: "failed",
            errorCode: runtimeProviderCancellationUnconfirmedCode,
            externalThreadId: "external-thread-1",
            externalRunId: null,
            startedAt: new Date(now.getTime() - recoveryWindowMs),
            providerCancellationResolution: null,
          }],
        })),
      },
      $transaction: resolution.transaction,
    };
    const processor = new RunProcessor(
      db as never,
      runtime as never,
      noKnowledgeToolGrants(),
      undefined,
      undefined,
      recoveryWindowMs,
    );

    await expect(processor.cancel("run-1")).rejects.toThrow(
      runtimeProviderCancellationUnconfirmedCode,
    );
    expect(resolution.create).not.toHaveBeenCalled();
  });
});

function providerCancellationResolutionHarness(
  externalRunId: string | null = "external-run-1",
  runErrorDetail = "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
) {
  const state = {
    ownerId: null as string | null,
    epoch: 0,
    leaseExpiresAt: null as Date | null,
    operationEpoch: 0,
    operationStartedAt: null as Date | null,
    operationDeadlineAt: null as Date | null,
    resolutionId: null as string | null,
  };
  const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if ("executionOwnerId" in data) {
      state.ownerId = data.executionOwnerId as string | null;
    }
    if (typeof data.executionEpoch === "number") state.epoch = data.executionEpoch;
    if ("executionLeaseExpiresAt" in data) {
      state.leaseExpiresAt = data.executionLeaseExpiresAt as Date | null;
    }
    if (typeof data.providerCancellationOperationEpoch === "number") {
      state.operationEpoch = data.providerCancellationOperationEpoch;
    }
    if ("providerCancellationOperationStartedAt" in data) {
      state.operationStartedAt = data.providerCancellationOperationStartedAt as Date | null;
    }
    if ("providerCancellationOperationDeadlineAt" in data) {
      state.operationDeadlineAt = data.providerCancellationOperationDeadlineAt as Date | null;
    }
    return { count: 1 };
  });
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    state.resolutionId = String(data.runtimeAttemptId);
    return data;
  });
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    $queryRaw: vi.fn(async () => [{
      databaseNow: new Date(),
      runStatus: "failed",
      runErrorCode: runtimeProviderCancellationUnconfirmedCode,
      runErrorDetail,
      runOwnerId: state.ownerId,
      runEpoch: state.epoch,
      runLeaseExpiresAt: state.leaseExpiresAt,
      attemptStatus: "failed",
      attemptErrorCode: runtimeProviderCancellationUnconfirmedCode,
      attemptOwnerId: state.ownerId,
      attemptEpoch: state.epoch,
      attemptLeaseExpiresAt: state.leaseExpiresAt,
      providerCancellationOperationEpoch: state.operationEpoch,
      providerCancellationOperationStartedAt: state.operationStartedAt,
      providerCancellationOperationDeadlineAt: state.operationDeadlineAt,
      providerCancellationResolutionId: state.resolutionId,
      externalRunId,
      providerIdempotencyKey: null,
      submissionUnknownAt: now,
      externalEventSequence: 0,
      lastExternalEventId: null,
      attempt: 1,
    }]),
    run: { updateMany },
    runtimeAttempt: { updateMany },
    runtimeProviderCancellationResolution: { create },
  }));
  return { create, transaction };
}
