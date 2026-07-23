import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import {
  applyPrototypePatch,
  canonicalJson,
  canonicalPrototypeScreenProjection,
  projectPrototypeScreen,
  type CanvasAgentToolDescriptor,
  type PrdDocument,
} from "@workbench/workbench-contracts";
import { createKnowledgeToolGrant, verifyKnowledgeToolGrant } from "@workbench/workbench-knowledge";
import { afterEach } from "vitest";
import {
  assistantTextDelta,
  assertCanvasToolCausality,
  createMultipartUploadStream,
  DeerFlowRuntimeAdapter,
  extractRuntimeInputRequired,
  KnowledgeGrantRedactionFilter,
  normalizeApprovalOptions,
  normalizeUploadVirtualPath,
  resolveRuntimeResult,
  runtimeThreadUuid,
  runtimeResumeValue,
} from "../src/runtime/deerflow-runtime.adapter.js";
import type {
  RuntimeExecution,
  RuntimeExecutionObserver,
} from "../src/runtime/runtime.port.js";
import { S3RuntimeReadyBlobReader } from "../src/storage/s3-runtime-ready-blob-reader.js";

function workerConfig() {
  return {
    databaseUrl: "postgresql://localhost/workbench",
    queueConnectionString: "postgresql://localhost/workbench",
    deerFlowLangGraphUrl: "http://deerflow.test/api",
    deerFlowGatewayUrl: "http://gateway.test",
    deerFlowAssistantId: "lead_agent",
    deerFlowInternalToken: "internal",
    deerFlowStreamMode: ["messages", "values"],
    deerFlowTimeoutMs: 5_000,
    deerFlowSubmissionTimeoutMs: 5_000,
    deerFlowIdleTimeoutMs: 5_000,
    concurrency: 1,
    knowledgeTool: null,
    s3Bucket: "workbench",
    s3Region: "us-east-1",
    s3InternalEndpoint: "http://s3.test",
    s3ForcePathStyle: true,
    runtimeReadyBlobS3AccessKeyId: "runtime-access",
    runtimeReadyBlobS3SecretAccessKey: "runtime-secret",
  };
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function checksummedArtifact<T extends Record<string, unknown>>(payload: T) {
  return { ...payload, checksum: sha256(canonicalJson(payload)) };
}

function runtimePresetSnapshot() {
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
    source: { presetId, version, checksum: sha256(canonicalJson(definition)) },
    ...payload,
  };
}

function execution(overrides: Partial<RuntimeExecution> = {}): RuntimeExecution {
  return {
    runId: "run_1",
    runtimeAttemptId: "attempt_1",
    attempt: 1,
    projectId: "project_1",
    threadId: "thread_1",
    principalId: "principal_1",
    externalThreadId: "deer_thread_1",
    request: {
      prompt: "Build the product",
      modelId: "quality",
      workflow: "generate",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: [],
    },
    artifactTargets: [],
    prototypePatchBaselines: [],
    sources: [],
    designAssets: [],
    knowledgeTool: null,
    designStyleSnapshot: null,
    resume: null,
    providerTextState: {
      protocol: "workbench.runtime-provider-text-state.v2",
      rawAssistantText: "",
      visibleAssistantText: "",
      durableVisibleAssistantText: "",
      redactionBuffer: "",
      committedFinalization: null,
    },
    submission: {
      mode: "submit",
      providerIdempotencyKey: "wbrt:test-attempt-key",
    },
    ...overrides,
  };
}

function canvasToolDescriptor(
  declaredTools: CanvasAgentToolDescriptor["reference"]["declaredTools"],
): CanvasAgentToolDescriptor {
  return {
    protocol: "workbench.canvas-agent-tool-descriptor.v1",
    endpoint: "https://workbench.test/api/v1/runtime/canvas/tools/execute",
    token: `wbct1.${"a".repeat(64)}.${"b".repeat(43)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    visualEndpoint: "https://workbench.test/api/v1/runtime/canvas/visuals",
    reference: {
      protocol: "workbench.canvas-agent-tool-reference.v1",
      declarationRevision: 1,
      declarationSha256: "c".repeat(64),
      declaredTools: [...declaredTools],
    },
  };
}

function validatedResultArtifact(
  result: unknown,
  {
    runId = "run_1",
    runtimeAttemptId = "attempt_1",
    toolCallId = "result-call-1",
  }: {
    runId?: string;
    runtimeAttemptId?: string;
    toolCallId?: string;
  } = {},
) {
  const envelope = {
    protocol: "workbench.runtime.validated-result.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    ok: true,
    resultChecksum: sha256(canonicalJson(result)),
  };
  return {
    ...envelope,
    result,
    checksum: sha256(canonicalJson(envelope)),
  };
}

function invalidResultArtifact(
  issues: unknown[],
  {
    runId = "run_1",
    runtimeAttemptId = "attempt_1",
    toolCallId = "result-call-invalid",
  }: {
    runId?: string;
    runtimeAttemptId?: string;
    toolCallId?: string;
  } = {},
) {
  const envelope = {
    protocol: "workbench.runtime.validated-result.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    ok: false,
  };
  return {
    ...envelope,
    issues,
    checksum: sha256(canonicalJson(envelope)),
  };
}

function declaredToolMessages(toolName: string, toolCallId: string, artifact: unknown) {
  return [
    {
      type: "ai",
      content: "",
      tool_calls: [{ id: toolCallId, name: toolName, args: {} }],
    },
    {
      type: "tool",
      name: toolName,
      tool_call_id: toolCallId,
      artifact,
    },
  ];
}

function canvasToolMessages(
  status: "succeeded" | "waiting_client" | "waiting_approval",
  toolCallId = "canvas-call-1",
  toolName = "get_selected_screens",
) {
  const base = {
    protocol: "workbench.canvas-agent-tool.v1",
    agentSessionId: "canvas-session-1",
    toolCallId,
    toolName,
    boardRevision: 4,
    canvasStateRevision: 2,
    responseSha256: "a".repeat(64),
  };
  const artifact = status === "succeeded"
    ? {
        ...base,
        status,
        data: { kind: "none", items: [], truncated: false },
        failure: null,
        approvalId: null,
        clientCommandId: null,
      }
    : status === "waiting_client"
      ? {
          ...base,
          status,
          data: null,
          failure: null,
          approvalId: null,
          clientCommandId: "canvas-command-1",
        }
      : {
          ...base,
          status,
          data: null,
          failure: null,
          approvalId: "canvas-approval-1",
          clientCommandId: null,
        };
  return declaredToolMessages(toolName, toolCallId, artifact);
}

function canvasCausalityFixture(
  beforeResult: unknown[],
  afterResult: unknown[] = [],
) {
  const resultMessages = declaredToolMessages(
    "workbench_runtime_result_submit",
    "result-call-1",
    {},
  );
  const declarationIndex = beforeResult.length + 1;
  return {
    state: {
      messages: [
        { type: "human", content: "Edit the selected screen" },
        ...beforeResult,
        ...resultMessages,
        ...afterResult,
      ],
    },
    result: { declarationIndex, responseIndex: declarationIndex + 1 },
  };
}

function validatedResultToolMessages(
  result: unknown,
  toolCallId = "result-call-1",
  scope: { runId?: string; runtimeAttemptId?: string } = {},
) {
  return declaredToolMessages(
    "workbench_runtime_result_submit",
    toolCallId,
    validatedResultArtifact(result, { ...scope, toolCallId }),
  );
}

function invalidResultToolMessages(
  issues: unknown[],
  toolCallId = "result-call-invalid",
  scope: { runId?: string; runtimeAttemptId?: string } = {},
) {
  return declaredToolMessages(
    "workbench_runtime_result_submit",
    toolCallId,
    invalidResultArtifact(issues, { ...scope, toolCallId }),
  );
}

function artifactDraftToolMessages(
  draft: unknown,
  artifactIndex = 0,
  toolCallId = `artifact-draft-call-${artifactIndex}`,
  scope: { runId?: string; runtimeAttemptId?: string } = {},
) {
  const envelope = {
    protocol: "workbench.runtime.artifact-draft.v1",
    runId: scope.runId ?? "run_1",
    runtimeAttemptId: scope.runtimeAttemptId ?? "attempt_1",
    toolCallId,
    artifactIndex,
    ok: true,
    draftChecksum: sha256(canonicalJson(draft)),
  };
  return declaredToolMessages(
    "workbench_artifact_draft_publish",
    toolCallId,
    {
      ...envelope,
      draft,
      checksum: sha256(canonicalJson(envelope)),
    },
  );
}

function prototypePatchToolMessages(
  patch: unknown,
  toolCallId = "prototype-patch-call-1",
  scope: { runId?: string; runtimeAttemptId?: string } = {},
) {
  const envelope = {
    protocol: "workbench.runtime.prototype-patch-publication.v1",
    runId: scope.runId ?? "run_1",
    runtimeAttemptId: scope.runtimeAttemptId ?? "attempt_1",
    toolCallId,
    ok: true,
    patchChecksum: sha256(canonicalJson(patch)),
  };
  return declaredToolMessages(
    "workbench_prototype_patch_publish",
    toolCallId,
    {
      ...envelope,
      patch,
      checksum: sha256(canonicalJson(envelope)),
    },
  );
}

function generationStageToolMessages(
  stage: "design-system" | "mapping-components" | "creating-flows" | "generating-ui",
  {
    runId = "run_1",
    runtimeAttemptId = "attempt_1",
    toolCallId = `stage-${stage}`,
  }: {
    runId?: string;
    runtimeAttemptId?: string;
    toolCallId?: string;
  } = {},
) {
  const payload = {
    protocol: "workbench.runtime.generation-stage.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    stage,
  };
  return declaredToolMessages(
    "workbench_generation_stage_update",
    toolCallId,
    { ...payload, checksum: sha256(canonicalJson(payload)) },
  );
}

function knowledgeDescriptor(secret: Uint8Array) {
  const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
  return {
    protocol: "workbench.knowledge-tool.v1" as const,
    endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
    token: createKnowledgeToolGrant({
      grantId: "grant_1",
      runId: "run_1",
      runtimeAttemptId: "attempt_1",
      principalId: "principal_1",
      projectId: "project_1",
      releaseId: "release_1",
      mode: "hybrid",
      routeScope: "production",
      issuedAt,
      expiresAt,
    }, secret, { now: issuedAt, maximumTtlSeconds: 900 }),
    expiresAt: expiresAt.toISOString(),
    releaseId: "release_1",
    mode: "hybrid" as const,
    routeScope: "production" as const,
  };
}

function observer(): RuntimeExecutionObserver & {
  [Key in keyof RuntimeExecutionObserver]: ReturnType<typeof vi.fn>;
} & { onEvent: ReturnType<typeof vi.fn> } {
  const onEvent = vi.fn(async () => undefined);
  return {
    onSubmissionStarted: vi.fn(async () => undefined),
    onExternalRunCreated: vi.fn(async () => undefined),
    isExternalEventProcessed: vi.fn(async () => false),
    onExternalEvent: vi.fn(async (_part, effects) => {
      for (const event of effects) await onEvent(event);
    }),
    onExternalFinalization: vi.fn(async (_part, effects) => {
      for (const event of effects) await onEvent(event);
    }),
    onEvent,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeerFlow runtime adapter", () => {
  it("converts cumulative assistant content into deltas", () => {
    expect(assistantTextDelta("hello", "hello world")).toBe(" world");
    expect(assistantTextDelta("hello world", "hello world")).toBe("");
  });

  it("preserves repeated delta text instead of guessing overlap", () => {
    expect(assistantTextDelta("ha", "ha", "delta")).toBe("ha");
    expect(assistantTextDelta("```ts\nconst value = 1;\n```", "```ts\nconst value = 1;\n```", "delta"))
      .toBe("```ts\nconst value = 1;\n```");
  });

  it("accepts only strict cumulative-prefix progression", () => {
    expect(assistantTextDelta("hello world", "hello", "cumulative")).toBe("");
    expect(() => assistantTextDelta("hello world", "hello there", "cumulative"))
      .toThrow("RUNTIME_ASSISTANT_CUMULATIVE_CONFLICT");
  });

  it("redacts Knowledge capability tokens even when streamed across chunks", () => {
    const filter = new KnowledgeGrantRedactionFilter();
    const token = `wbkg1.${"a".repeat(80)}.${"b".repeat(43)}`;
    const visible = [
      filter.push(`before ${token.slice(0, 4)}`),
      filter.push(token.slice(4, 50)),
      filter.push(`${token.slice(50)} after`),
      filter.flush(),
    ].join("");
    expect(visible).toBe("before [knowledge capability redacted] after");
    expect(visible).not.toContain("wbkg1");
    expect(visible).not.toContain("a".repeat(20));
  });

  it("routes the redaction tail through one stable end-of-stream finalization identity", async () => {
    const token = `wbkg1.${"a".repeat(80)}.${"b".repeat(43)}`;
    const finalState = {
      node: "writer",
      messages: [
        { type: "human", content: "current turn" },
        ...validatedResultToolMessages({
          protocol: "workbench.runtime.result.v1" as const,
          message: "done",
          artifacts: [],
        }, "redaction-tail-result"),
        { type: "ai", content: `visible ${token}` },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "redaction-tail-event",
          event: "values",
          data: finalState,
        }], { runId: "external_run_redaction_tail" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));

    const finalizations = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const runtimeObserver = observer();
      const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
      await adapter.execute(execution(), runtimeObserver);
      expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
        expect.objectContaining({ externalEventId: "redaction-tail-event" }),
        expect.arrayContaining([
          expect.objectContaining({ type: "activity", activityId: "deerflow:writer", status: "running" }),
          { type: "text.delta", delta: "visible " },
        ]),
      );
      expect(runtimeObserver.onExternalFinalization).toHaveBeenCalledWith(
        expect.objectContaining({
          externalRunId: "external_run_redaction_tail",
          externalEventId: expect.stringMatching(/^workbench-finalization:[0-9a-f]{64}$/u),
          event: "workbench.runtime.finalization.v2",
          payload: expect.objectContaining({
            visibleFinalEffect: {
              type: "text.final",
              text: "visible [knowledge capability redacted]",
            },
            effectsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            providerTextCheckpointSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          }),
        }),
        [],
      );
      finalizations.push(runtimeObserver.onExternalFinalization.mock.calls[0]?.[0]);
    }
    expect(finalizations[1]).toEqual(finalizations[0]);
  });

  it("does not persist the SDK-inherited cursor on DeerFlow's end sentinel", async () => {
    const finalState = {
      messages: [
        { type: "human", content: "current turn" },
        ...validatedResultToolMessages({
          protocol: "workbench.runtime.result.v1" as const,
          message: "done",
          artifacts: [],
        }, "end-sentinel-result"),
        { type: "ai", content: "done" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          { id: "provider-event-before-end", event: "values", data: finalState },
          { event: "end", data: null },
        ], { runId: "external_run_end_sentinel" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({
      protocol: "workbench.runtime.result.v1",
      message: "done",
    });

    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledTimes(1);
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRunId: "external_run_end_sentinel",
        externalEventId: "provider-event-before-end",
        event: "values",
      }),
      expect.any(Array),
    );
    expect(runtimeObserver.onExternalFinalization).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed DeerFlow end sentinel without finalizing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          {
            id: "provider-event-before-malformed-end",
            event: "metadata",
            data: { run_id: "external_run_malformed_end" },
          },
          { event: "end", data: { unexpected: true } },
        ], { runId: "external_run_malformed_end" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver))
      .rejects.toThrow("DEERFLOW_STREAM_END_INVALID");
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledTimes(1);
    expect(runtimeObserver.onExternalFinalization).not.toHaveBeenCalled();
  });

  it("preserves identical provider payloads when their explicit event IDs differ", async () => {
    const repeatedPayload = { repeated: true };
    const finalState = {
      messages: [
        { type: "human", content: "current turn" },
        ...validatedResultToolMessages({
          protocol: "workbench.runtime.result.v1" as const,
          message: "done",
          artifacts: [],
        }, "repeated-payload-result"),
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          {
            id: "provider-repeated-payload-1",
            event: "updates",
            data: repeatedPayload,
          },
          {
            id: "provider-repeated-payload-2",
            event: "updates",
            data: repeatedPayload,
          },
          { id: "provider-final-values", event: "values", data: finalState },
        ], { runId: "external_run_repeated_payload" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({
      protocol: "workbench.runtime.result.v1",
      message: "done",
    });

    const repeatedParts = runtimeObserver.onExternalEvent.mock.calls
      .map(([part]) => part)
      .filter((part) => part.event === "updates");
    expect(repeatedParts).toEqual([
      expect.objectContaining({
        externalEventId: "provider-repeated-payload-1",
        payload: repeatedPayload,
      }),
      expect.objectContaining({
        externalEventId: "provider-repeated-payload-2",
        payload: repeatedPayload,
      }),
    ]);
  });

  it("skips every in-memory effect when the provider replays a processed event", async () => {
    const finalState = {
      messages: [
        { type: "human", content: "current turn" },
        ...validatedResultToolMessages({
          protocol: "workbench.runtime.result.v1" as const,
          message: "done",
          artifacts: [],
        }, "processed-replay-result"),
        { type: "ai", content: "done" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          {
            id: "processed-replay-event",
            event: "values",
            data: {
              node: "must-not-run",
              messages: [{ type: "ai", content: "must-not-emit" }],
            },
          },
          { id: "fresh-final-event", event: "values", data: finalState },
        ], { runId: "external_run_processed_replay" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    runtimeObserver.isExternalEventProcessed.mockImplementation(async (part) => (
      part.externalEventId === "processed-replay-event"
    ));
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({
      protocol: "workbench.runtime.result.v1",
      message: "done",
    });

    expect(runtimeObserver.isExternalEventProcessed).toHaveBeenCalledTimes(2);
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledTimes(1);
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: "fresh-final-event" }),
      [
        {
          type: "generation.stage",
          stage: "summarizing",
          sourceEventId: expect.stringMatching(/^deerflow:[0-9a-f]{64}$/u),
        },
        { type: "text.delta", delta: "done" },
      ],
    );
    expect(runtimeObserver.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ activityId: "deerflow:must-not-run" }),
    );
  });

  it("does not persist finalization again after resuming a committed terminal projection", async () => {
    const token = `wbkg1.${"a".repeat(80)}.${"b".repeat(43)}`;
    const terminalText = `before ${token}`;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return successfulRuntimeResponse({
          runId: "external_run_finalized_resume",
          assistantText: terminalText,
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      providerTextState: {
        protocol: "workbench.runtime-provider-text-state.v2",
        rawAssistantText: terminalText,
        visibleAssistantText: "before [knowledge capability redacted]",
        durableVisibleAssistantText: "before [knowledge capability redacted]",
        redactionBuffer: "",
        committedFinalization: {
          externalEventId: "workbench-finalization:committed",
          payloadSha256: "a".repeat(64),
        },
      },
    }), runtimeObserver)).resolves.toMatchObject({
      protocol: "workbench.runtime.result.v1",
      message: "done",
    });

    expect(runtimeObserver.onExternalFinalization).not.toHaveBeenCalled();
  });

  it("routes effects recovered only from the terminal thread state through finalization", async () => {
    const messages = [
      { type: "human", content: "current turn" },
      ...generationStageToolMessages("design-system", { toolCallId: "terminal-state-stage" }),
      ...validatedResultToolMessages({
        protocol: "workbench.runtime.result.v1" as const,
        message: "done",
        artifacts: [],
      }, "terminal-state-result"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "terminal-metadata-event",
          event: "metadata",
          data: { run_id: "external_run_terminal_state" },
        }], { runId: "external_run_terminal_state" });
      }
      if (url.pathname === "/api/threads/deer_thread_1/state" && (init.method ?? "GET") === "GET") {
        return Response.json({ values: { messages } });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({ message: "done" });

    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: "terminal-metadata-event" }),
      [],
    );
    expect(runtimeObserver.onExternalFinalization).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRunId: "external_run_terminal_state",
        event: "workbench.runtime.finalization.v2",
      }),
      [{
        type: "generation.stage",
        stage: "design-system",
        sourceEventId: expect.stringMatching(/^deerflow:[0-9a-f]{64}$/u),
      }],
    );
  });

  it("projects terminal-only assistant text as one chunk-independent visible final effect", async () => {
    const terminalState = {
      __interrupt__: [{
        id: "interrupt_terminal_text",
        resumable: true,
        value: { kind: "confirmation", question: "Continue?", options: [] },
      }],
      messages: [
        { type: "human", content: "current turn" },
        { type: "ai", content: "terminal-only assistant text" },
      ],
    };
    const finalizations: Array<Record<string, unknown>> = [];
    for (const streamedPrefix of [null, "terminal-only "] as const) {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
          return Response.json([]);
        }
        if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
          return runtimeStreamResponse(streamedPrefix ? [{
            id: `terminal-prefix-${streamedPrefix.length}`,
            event: "messages",
            data: { type: "ai", content: streamedPrefix },
          }] : [], { runId: "external_run_terminal_text" });
        }
        if (url.pathname === "/api/threads/deer_thread_1/state" && (init.method ?? "GET") === "GET") {
          return Response.json(terminalState);
        }
        throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
      }));
      const runtimeObserver = observer();
      const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

      await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({
        protocol: "workbench.runtime.input-required.v1",
      });

      const part = runtimeObserver.onExternalFinalization.mock.calls[0]?.[0] as Record<string, unknown>;
      finalizations.push(part);
      expect(part.payload).toMatchObject({
        visibleFinalEffect: {
          type: "text.final",
          text: "terminal-only assistant text",
        },
      });
      expect(runtimeObserver.onExternalFinalization).toHaveBeenCalledWith(part, []);
    }
    expect((finalizations[1]?.payload as { effectsSha256: string }).effectsSha256)
      .toBe((finalizations[0]?.payload as { effectsSha256: string }).effectsSha256);
  });

  it("accepts a declared Canvas tool with a terminal response before the Runtime result", () => {
    const fixture = canvasCausalityFixture(canvasToolMessages("succeeded"));
    expect(() => assertCanvasToolCausality(
      fixture.state,
      ["get_selected_screens"],
      fixture.result,
    )).not.toThrow();
  });

  it("rejects a Canvas call that was not included in the issued declaration", () => {
    const fixture = canvasCausalityFixture(canvasToolMessages("succeeded"));
    expect(() => assertCanvasToolCausality(fixture.state, [], fixture.result))
      .toThrow("RUNTIME_CANVAS_TOOL_NOT_DECLARED");
  });

  it.each([
    {
      name: "missing",
      messages: canvasToolMessages("succeeded").slice(0, 1),
      error: "RUNTIME_CANVAS_TOOL_RESPONSE_MISSING",
    },
    {
      name: "forged",
      messages: canvasToolMessages("succeeded").slice(1),
      error: "RUNTIME_CANVAS_TOOL_MESSAGE_UNDECLARED",
    },
  ])("rejects a $name Canvas ToolMessage", ({ messages, error }) => {
    const fixture = canvasCausalityFixture(messages);
    expect(() => assertCanvasToolCausality(
      fixture.state,
      ["get_selected_screens"],
      fixture.result,
    )).toThrow(error);
  });

  it.each(["waiting_client", "waiting_approval"] as const)(
    "rejects a %s Canvas response before accepting the Runtime result",
    (status) => {
      const fixture = canvasCausalityFixture(canvasToolMessages(status));
      expect(() => assertCanvasToolCausality(
        fixture.state,
        ["get_selected_screens"],
        fixture.result,
      )).toThrow("RUNTIME_CANVAS_TOOL_PENDING");
    },
  );

  it("rejects a Canvas call added after the Runtime result", () => {
    const fixture = canvasCausalityFixture([], canvasToolMessages("succeeded").slice(0, 1));
    expect(() => assertCanvasToolCausality(
      fixture.state,
      ["get_selected_screens"],
      fixture.result,
    )).toThrow("RUNTIME_CANVAS_TOOL_AFTER_RESULT");
  });

  it("rejects a Canvas response added after the Runtime result", () => {
    const [call, response] = canvasToolMessages("succeeded");
    const fixture = canvasCausalityFixture([call], [response]);
    expect(() => assertCanvasToolCausality(
      fixture.state,
      ["get_selected_screens"],
      fixture.result,
    )).toThrow("RUNTIME_CANVAS_TOOL_RESPONSE_AFTER_RESULT");
  });

  it("requires one validated submit ToolMessage from the current turn", () => {
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "done",
      artifacts: [{
        kind: "prd" as const,
        title: "PRD",
        schemaVersion: 1 as const,
        operation: { kind: "create" as const },
        content: minimalPrdDocument(),
        citations: [],
      }],
    };
    expect(resolveRuntimeResult({
      values: {
        messages: [
          { type: "human", content: "生成 PRD" },
          ...validatedResultToolMessages(result),
          { type: "ai", content: "已完成。", additional_kwargs: {} },
        ],
      },
    }, ["prd"], execution())).toMatchObject({
      message: "done",
      artifacts: [{ operation: { kind: "create" } }],
    });
    expect(() => resolveRuntimeResult({ workbench_result: result }, ["prd"], execution()))
      .toThrow("RUNTIME_RESULT_SUBMISSION_MISSING");
  });

  it("accepts Node-canonical numeric payloads and rejects nested result tampering", () => {
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "numeric",
      artifacts: [{
        title: "Numeric data",
        citations: [],
        operation: { kind: "create" as const },
        kind: "data" as const,
        schemaVersion: 1,
        content: { whole: 1.0, scientific: 1e-7 },
      }],
    };
    const artifact = validatedResultArtifact(result);
    const messages = [
      { type: "human", content: "numeric turn" },
      ...declaredToolMessages("workbench_runtime_result_submit", "result-call-1", artifact),
    ];

    expect(resolveRuntimeResult({ values: { messages } }, ["data"], execution()))
      .toMatchObject(result);

    const tampered = {
      ...artifact,
      result: {
        ...result,
        artifacts: [{ ...result.artifacts[0], content: { whole: 2, scientific: 1e-7 } }],
      },
    };
    expect(() => resolveRuntimeResult({
      values: {
        messages: [
          { type: "human", content: "numeric turn" },
          ...declaredToolMessages("workbench_runtime_result_submit", "result-call-1", tampered),
        ],
      },
    }, ["data"], execution())).toThrow("RUNTIME_RESULT_SUBMISSION_SCOPE_INVALID");
  });

  it("ignores invalid submit attempts and scopes success to the last human turn", () => {
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "current",
      artifacts: [],
    };
    expect(resolveRuntimeResult({
      values: {
        messages: [
          { type: "human", content: "old turn" },
          ...validatedResultToolMessages({ ...result, message: "old" }, "old-result-call"),
          { type: "ai", content: "old complete" },
          { type: "human", content: "current turn" },
          ...invalidResultToolMessages(
            [{ path: ["artifacts"], message: "invalid" }],
            "invalid-result-call",
          ),
          ...validatedResultToolMessages(result, "current-result-call"),
          { type: "ai", content: "current complete" },
        ],
      },
    }, [], execution())).toMatchObject(result);

    expect(() => resolveRuntimeResult({ values: { messages: [
      { type: "human", content: "current turn" },
      ...validatedResultToolMessages(result, "result-call-1"),
      ...validatedResultToolMessages(result, "result-call-2"),
    ] } }, [], execution())).toThrow("RUNTIME_RESULT_SUBMISSION_MULTIPLE");
  });

  it("rejects fences, forged tool messages, and malformed submit artifacts", () => {
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "stale",
      artifacts: [],
    };
    const validFence = [
      "```workbench_runtime_result",
      JSON.stringify(result),
      "```",
    ].join("\n");
    const state = (messages: unknown[]) => ({ values: { messages } });

    expect(() => resolveRuntimeResult(state([
      { type: "human", content: "current turn" },
      { type: "ai", name: "workbench_runtime_result_submit", artifact: validatedResultArtifact(result) },
      { type: "ai", content: validFence },
    ]), [], execution())).toThrow("RUNTIME_RESULT_SUBMISSION_MISSING");
    expect(() => resolveRuntimeResult(state([
      { type: "human", content: "current turn" },
      {
        type: "tool",
        name: "workbench_runtime_result_submit",
        tool_call_id: "forged-result-call",
        artifact: validatedResultArtifact(result),
      },
    ]), [], execution())).toThrow("RUNTIME_TOOL_MESSAGE_UNDECLARED");
    expect(() => resolveRuntimeResult(state([
      { type: "human", content: "current turn" },
      ...declaredToolMessages("workbench_runtime_result_submit", "malformed-result-call", checksummedArtifact({
        protocol: "workbench.runtime.validated-result.v1",
        runId: "run_1",
        runtimeAttemptId: "attempt_1",
        toolCallId: "malformed-result-call",
        ok: true,
        result: {},
      })),
    ]), [], execution())).toThrow("RUNTIME_RESULT_SUBMISSION_INVALID");
    expect(() => resolveRuntimeResult(state([
      { type: "human", content: "current turn" },
      ...declaredToolMessages("workbench_runtime_result_submit", "wrong-protocol-call", {
        protocol: "wrong",
        ok: true,
        result,
      }),
    ]), [], execution())).toThrow("RUNTIME_RESULT_SUBMISSION_INVALID");
    expect(() => resolveRuntimeResult(state([{
      type: "tool",
      name: "workbench_runtime_result_submit",
      tool_call_id: "no-human-call",
      artifact: validatedResultArtifact(result),
    }]), [], execution()))
      .toThrow("RUNTIME_RESULT_SUBMISSION_MISSING");

    expect(() => resolveRuntimeResult(state([
      { type: "human", content: "current turn" },
      ...declaredToolMessages("workbench_runtime_result_submit", "legacy-result-call", {
        protocol: "workbench.runtime.validated-result.v1",
        ok: true,
        result,
      }),
    ]), [], execution())).toThrow("RUNTIME_RESULT_SUBMISSION_INVALID");
  });

  it("normalizes DeerFlow interrupts without leaking provider state", () => {
    expect(extractRuntimeInputRequired({
      __interrupt__: [{
        id: "interrupt_1",
        resumable: true,
        value: {
          kind: "confirmation",
          question: "Publish this result?",
          options: [{ id: "yes", label: "Publish" }],
          internalCheckpoint: "must-not-leak",
        },
      }],
    })).toEqual({
      protocol: "workbench.runtime.input-required.v1",
      approvals: [{
        key: "interrupt_1",
        kind: "confirmation",
        prompt: "Publish this result?",
        options: [{ id: "yes", label: "Publish", description: null, value: "yes" }],
      }],
    });
  });

  it("derives the same fallback interrupt id from canonically equivalent JSON", () => {
    const first = extractRuntimeInputRequired({
      __interrupt__: [{ value: { question: "Continue?", kind: "confirmation" } }],
    });
    const reordered = extractRuntimeInputRequired({
      __interrupt__: [{ value: { kind: "confirmation", question: "Continue?" } }],
    });

    expect(first?.approvals[0]?.key).toMatch(/^interrupt-0-[0-9a-f]{24}$/);
    expect(reordered?.approvals[0]?.key).toBe(first?.approvals[0]?.key);
  });

  it("normalizes string and common object approval options into a stable JSON contract", () => {
    expect(normalizeApprovalOptions([
      "Retry",
      { value: "publish", label: "Publish", detail: "Publish now" },
      { id: 3, name: "Third", value: { rank: 3 }, internal: "must-not-leak" },
    ])).toEqual([
      { id: "Retry", label: "Retry", description: null, value: "Retry" },
      { id: "publish", label: "Publish", description: "Publish now", value: "publish" },
      { id: "3", label: "Third", description: null, value: { rank: 3 } },
    ]);
  });

  it("rejects approval options that cannot be normalized without guessing", () => {
    expect(() => normalizeApprovalOptions(null)).toThrow("RUNTIME_APPROVAL_OPTIONS_INVALID");
    expect(() => normalizeApprovalOptions([42])).toThrow("RUNTIME_APPROVAL_OPTION_INVALID");
    expect(() => normalizeApprovalOptions([{ description: "missing identity and value" }]))
      .toThrow("RUNTIME_APPROVAL_OPTION_INVALID");
    expect(() => normalizeApprovalOptions([
      { id: "same", label: "One" },
      { id: "same", label: "Two" },
    ])).toThrow("RUNTIME_APPROVAL_OPTIONS_INVALID");
    expect(() => normalizeApprovalOptions(Array.from({ length: 51 }, () => "option")))
      .toThrow("RUNTIME_APPROVAL_OPTIONS_INVALID");
  });

  it("builds single and multi-interrupt resume values", () => {
    expect(runtimeResumeValue([{ key: "one", decision: "approve" }])).toEqual({ approved: true });
    expect(runtimeResumeValue([
      { key: "one", decision: "approve" },
      { key: "two", decision: "submit", value: { answer: 42 } },
    ])).toEqual({
      one: { approved: true },
      two: { answer: 42 },
    });
  });

  it("creates a new SDK run with recovery metadata and persists onRunCreated before events", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return successfulRuntimeResponse({
          runId: "external_run_new",
          eventId: "event-new-1",
          includeContentLocation: true,
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    const result = await adapter.execute(execution(), runtimeObserver);

    expect(result).toMatchObject({ protocol: "workbench.runtime.result.v1", message: "done" });
    const streamRequest = requests.find((request) => request.init.method === "POST");
    expect(streamRequest).toBeDefined();
    const submittedBody = JSON.parse(String(streamRequest?.init.body));
    expect(submittedBody).toMatchObject({
      assistant_id: "lead_agent",
      stream_resumable: true,
      metadata: {
        workbench_runtime_attempt_id: "attempt_1",
        workbench_run_id: "run_1",
        workbench_attempt: 1,
        workbench_provider_idempotency_key: "wbrt:test-attempt-key",
      },
      context: {
        workbench: {
          runId: "run_1",
          runtimeAttemptId: "attempt_1",
        },
      },
    });
    expect(submittedBody.input.messages[0].content)
      .toMatch(/^\/workbench\n<workbench_context>\n/u);
    expect(submittedBody.input.messages[0].content).toMatch(/<\/workbench_context>\nBuild the product$/u);
    expect(submittedBody.context.workbench.requestedArtifactKinds).toEqual([]);
    expect(submittedBody.config.configurable.workbench_canvas_tools).toBeNull();
    expect(runtimeObserver.onSubmissionStarted).toHaveBeenCalledTimes(1);
    expect(runtimeObserver.onExternalRunCreated).toHaveBeenCalledWith("external_run_new");
    expect(runtimeObserver.onExternalRunCreated.mock.invocationCallOrder[0])
      .toBeLessThan(runtimeObserver.onExternalEvent.mock.invocationCallOrder[0]!);
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRunId: "external_run_new",
        externalEventId: "event-new-1",
      }),
      expect.any(Array),
    );
  });

  it("sends the tokenless per-run Canvas declaration as an explicit configurable policy", async () => {
    let submittedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return successfulRuntimeResponse({ runId: "external_run_canvas_scope" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const descriptor = canvasToolDescriptor(["get_visible_screens", "view_screen"]);
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await adapter.execute(execution({ canvasTool: descriptor }), observer());

    const configurable = (submittedBody?.config as {
      configurable: Record<string, unknown>;
    }).configurable;
    expect(configurable.workbench_canvas_tools).toEqual({
      declaredTools: ["get_visible_screens", "view_screen"],
    });
    expect(JSON.stringify(configurable)).not.toMatch(/wbct1|token|endpoint|expiresAt/u);
    const secretValue = (submittedBody?.context as {
      secrets: { WORKBENCH_CANVAS_CAPABILITY: string };
    }).secrets.WORKBENCH_CANVAS_CAPABILITY;
    expect(JSON.parse(secretValue)).toEqual(descriptor);
  });

  it("sends requested Artifact kinds through the trusted Workbench runtime context", async () => {
    let submittedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return successfulRuntimeResponse({
          runId: "external_run_artifact_scope",
          artifacts: [{
            kind: "document",
            schemaVersion: 1,
            title: "Generated document",
            citations: [],
            operation: { kind: "create" },
            content: { body: "done" },
          }],
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await adapter.execute(execution({
      request: {
        ...execution().request,
        requestedArtifactKinds: ["document"],
      },
    }), observer());

    expect((submittedBody?.context as {
      workbench: { requestedArtifactKinds: string[] };
    }).workbench.requestedArtifactKinds).toEqual(["document"]);
    expect((submittedBody?.config as { configurable: Record<string, unknown> }).configurable)
      .not.toHaveProperty("requestedArtifactKinds");
    expect((submittedBody?.config as {
      configurable: { subagent_enabled: boolean };
    }).configurable.subagent_enabled).toBe(false);
  });

  it("classifies an unobservable submit response as submission_unknown", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      methods.push(init.method ?? "GET");
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        throw new TypeError("socket closed after request bytes were sent");
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).rejects.toMatchObject({
      name: "RuntimeSubmissionUnknownError",
      message: "RUNTIME_SUBMISSION_UNKNOWN",
    });

    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
    expect(methods.filter((method) => method === "GET")).toHaveLength(2);
    expect(runtimeObserver.onExternalRunCreated).not.toHaveBeenCalled();
  });

  it("recovers submission_unknown by metadata without issuing another POST", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === "/api/threads/deer_thread_1/runs") {
        return Response.json([runtimeRun("external_run_unknown_recovered")]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/external_run_unknown_recovered/stream") {
        return successfulRuntimeResponse({
          runId: "external_run_unknown_recovered",
          eventId: "event-unknown-recovered-1",
          includeContentLocation: false,
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      submission: {
        mode: "reconcile",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      },
    }), runtimeObserver))
      .resolves.toMatchObject({ protocol: "workbench.runtime.result.v1" });

    expect(requests.some((request) => request.init.method === "POST")).toBe(false);
    expect(runtimeObserver.onSubmissionStarted).not.toHaveBeenCalled();
    expect(runtimeObserver.onExternalRunCreated)
      .toHaveBeenCalledWith("external_run_unknown_recovered");
  });

  it("never re-POSTs after acceptance and a crash-before-attach while lookup is temporarily empty", async () => {
    const acceptedRunId = "external_run_crash_recovery";
    let providerRunVisible = false;
    let postCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json(providerRunVisible ? [runtimeRun(acceptedRunId)] : []);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        postCount += 1;
        return successfulRuntimeResponse({ runId: acceptedRunId });
      }
      if (url.pathname === `/api/threads/deer_thread_1/runs/${acceptedRunId}/stream`) {
        return successfulRuntimeResponse({
          runId: acceptedRunId,
          eventId: "event-crash-recovery-1",
          includeContentLocation: false,
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
    const killedWorkerObserver = observer();
    killedWorkerObserver.onExternalRunCreated.mockRejectedValueOnce(
      new Error("SIMULATED_WORKER_CRASH_BEFORE_EXTERNAL_RUN_ATTACH"),
    );

    await expect(adapter.execute(execution(), killedWorkerObserver)).rejects.toMatchObject({
      name: "RuntimeSubmissionUnknownError",
      message: "RUNTIME_SUBMISSION_RECONCILIATION_PERSISTENCE_UNKNOWN",
      cause: expect.objectContaining({
        message: "SIMULATED_WORKER_CRASH_BEFORE_EXTERNAL_RUN_ATTACH",
      }),
    });
    expect(postCount).toBe(1);

    const invisibleLookupObserver = observer();
    await expect(adapter.execute(execution({
      submission: {
        mode: "reconcile",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      },
    }), invisibleLookupObserver)).rejects.toMatchObject({
      name: "RuntimeSubmissionUnknownError",
      message: "RUNTIME_SUBMISSION_UNKNOWN",
    });
    expect(postCount).toBe(1);
    expect(invisibleLookupObserver.onSubmissionStarted).not.toHaveBeenCalled();

    providerRunVisible = true;
    const recoveredObserver = observer();
    await expect(adapter.execute(execution({
      submission: {
        mode: "reconcile",
        providerIdempotencyKey: "wbrt:test-attempt-key",
      },
    }), recoveredObserver)).resolves.toMatchObject({
      protocol: "workbench.runtime.result.v1",
    });
    expect(postCount).toBe(1);
    expect(recoveredObserver.onSubmissionStarted).not.toHaveBeenCalled();
    expect(recoveredObserver.onExternalRunCreated).toHaveBeenCalledWith(acceptedRunId);
  });

  it("emits trusted generation stages once when DeerFlow replays the same values state", async () => {
    const messages = [
      { type: "human", content: "current turn" },
      ...generationStageToolMessages("design-system", { toolCallId: "stage-design-system-1" }),
      ...validatedResultToolMessages({
        protocol: "workbench.runtime.result.v1",
        message: "done",
        artifacts: [],
      }, "stage-test-result"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          { id: "stage-event-1", event: "values", data: { messages } },
          { id: "stage-event-2", event: "values", data: { messages } },
        ], { runId: "external_run_stage" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({ message: "done" });

    const designStages = runtimeObserver.onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "generation.stage" && event.stage === "design-system");
    expect(designStages).toEqual([{
      type: "generation.stage",
      stage: "design-system",
      sourceEventId: expect.stringMatching(/^deerflow:[0-9a-f]{64}$/u),
    }]);
  });

  it("derives the same generation-stage source after an adapter restart and full values replay", async () => {
    const messages = [
      { type: "human", content: "current turn" },
      ...generationStageToolMessages("mapping-components", { toolCallId: "stable-stage-call" }),
      ...validatedResultToolMessages({
        protocol: "workbench.runtime.result.v1",
        message: "done",
        artifacts: [],
      }, "stable-result-call"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "restart-stage-event",
          event: "values",
          data: { messages },
        }], { runId: "external_run_restart" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));

    const sourceIds: string[] = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const runtimeObserver = observer();
      const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
      await adapter.execute(execution(), runtimeObserver);
      const stage = runtimeObserver.onEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === "generation.stage" && event.stage === "mapping-components");
      expect(stage).toBeDefined();
      if (stage?.type === "generation.stage") sourceIds.push(stage.sourceEventId);
    }

    expect(sourceIds).toHaveLength(2);
    expect(sourceIds[1]).toBe(sourceIds[0]);
  });

  it("persists a Prototype draft before screen-streaming and does not summarize values-only state", async () => {
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Prototype ready",
      artifacts: [{
        kind: "prototype" as const,
        title: "Prototype",
        schemaVersion: 1 as const,
        operation: { kind: "create" as const },
        content: minimalPrototypeDocument(),
        citations: [],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "prototype-event-1",
          event: "values",
          data: {
            messages: [
              { type: "human", content: "current turn" },
              ...artifactDraftToolMessages(result.artifacts[0], 0, "prototype-checkpoint-call"),
              ...validatedResultToolMessages(result, "prototype-result-call"),
            ],
          },
        }], { runId: "external_run_prototype" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const eventOrder: string[] = [];
    let releaseDraft!: () => void;
    const draftPersistence = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    runtimeObserver.onEvent.mockImplementation(async (event) => {
      if (event.type === "artifact.draft") {
        eventOrder.push("draft-started");
        await draftPersistence;
        eventOrder.push("draft-persisted");
      }
      if (event.type === "generation.stage") eventOrder.push(event.stage);
    });
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    const executionPromise = adapter.execute(execution({
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
    }), runtimeObserver);
    await vi.waitFor(() => expect(eventOrder).toEqual(["draft-started"]));
    releaseDraft();
    await expect(executionPromise).resolves.toMatchObject({ message: "Prototype ready" });

    const generationStages = runtimeObserver.onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "generation.stage")
      .map((event) => event.stage);
    expect(generationStages).toEqual(["screen-streaming"]);
    expect(eventOrder).toEqual([
      "draft-started",
      "draft-persisted",
      "screen-streaming",
      "draft-started",
      "draft-persisted",
    ]);
    const draftEvents = runtimeObserver.onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "artifact.draft");
    const checkpointScreens = [{
      screenId: "screen-home",
      revision: 0,
      checksum: sha256(canonicalPrototypeScreenProjection(
        projectPrototypeScreen(result.artifacts[0].content, "screen-home", 0),
      )),
    }];
    expect(draftEvents).toEqual([
      {
        type: "artifact.draft",
        artifactIndex: 0,
        draft: result.artifacts[0],
        sourceEventId: expect.stringMatching(/^deerflow:[0-9a-f]{64}$/u),
        checkpointScreens,
      },
      {
        type: "artifact.draft",
        artifactIndex: 0,
        draft: result.artifacts[0],
        sourceEventId: expect.stringMatching(/^deerflow:[0-9a-f]{64}$/u),
        checkpointScreens,
      },
    ]);
    expect(draftEvents[1]?.sourceEventId).not.toBe(draftEvents[0]?.sourceEventId);
  });

  it("enters summarizing only after a visible assistant messages event", async () => {
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Prototype ready",
      artifacts: [{
        kind: "prototype" as const,
        title: "Prototype",
        schemaVersion: 1 as const,
        operation: { kind: "create" as const },
        content: minimalPrototypeDocument(),
        citations: [],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          {
            id: "prototype-values-event",
            event: "values",
            data: {
              messages: [
                { type: "human", content: "current turn" },
                ...artifactDraftToolMessages(result.artifacts[0], 0, "prototype-summary-checkpoint"),
                ...validatedResultToolMessages(result, "prototype-summary-call"),
              ],
            },
          },
          {
            id: "prototype-summary-event",
            event: "messages",
            data: { type: "ai", content: "Design highlights are ready." },
          },
        ], { runId: "external_run_prototype_summary" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await adapter.execute(execution({
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
    }), runtimeObserver);

    const events = runtimeObserver.onEvent.mock.calls.map(([event]) => event);
    expect(events
      .filter((event) => event.type === "generation.stage")
      .map((event) => event.stage)).toEqual(["screen-streaming", "summarizing"]);
    expect(events).toContainEqual({
      type: "text.delta",
      delta: "Design highlights are ready.",
    });
  });

  it("persists two Prototype checkpoints in order and emits screen-streaming once per Attempt", async () => {
    const firstDraft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: minimalPrototypeDocument(),
      citations: [],
    };
    const latestDraft = {
      ...firstDraft,
      content: { ...firstDraft.content, revision: 2 },
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Prototype ready",
      artifacts: [latestDraft],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "checkpoint-sequence-event",
          event: "values",
          data: {
            messages: [
              { type: "human", content: "current turn" },
              ...artifactDraftToolMessages(firstDraft, 0, "checkpoint-call-1"),
              ...artifactDraftToolMessages(latestDraft, 0, "checkpoint-call-2"),
              ...validatedResultToolMessages(result, "checkpoint-final-call"),
            ],
          },
        }], { runId: "external_run_checkpoints" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
    }), runtimeObserver)).resolves.toMatchObject({ message: "Prototype ready" });

    const events = runtimeObserver.onEvent.mock.calls.map(([event]) => event);
    const draftEvents = events.filter((event) => event.type === "artifact.draft");
    expect(draftEvents).toHaveLength(3);
    expect(draftEvents.map((event) => event.type === "artifact.draft" && event.draft.content.revision))
      .toEqual([1, 2, 2]);
    expect(new Set(draftEvents.map((event) => event.sourceEventId))).toHaveProperty("size", 3);
    expect(events
      .filter((event) => event.type === "generation.stage")
      .map((event) => event.stage)).toEqual(["screen-streaming"]);
  });

  it("emits ordered trusted Prototype patches once between complete checkpoints", async () => {
    const initialDocument = minimalPrototypeDocument();
    const finalDocument = {
      ...initialDocument,
      screens: initialDocument.screens.map((screen) => ({
        ...screen,
        name: "Updated home",
      })),
    };
    const initialDraft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: initialDocument,
      citations: [],
    };
    const finalDraft = { ...initialDraft, content: finalDocument };
    const patchBatch = {
      screenId: "screen-home",
      baseRevision: 0,
      nextRevision: 1,
      operations: [{
        kind: "update_screen" as const,
        screenId: "screen-home",
        screen: finalDocument.screens[0]!,
      }],
      resultingChecksum: "0".repeat(64),
    };
    const patch = {
      protocol: "workbench.runtime.prototype-patch.v1" as const,
      artifactIndex: 0,
      ...patchBatch,
      resultingChecksum: sha256(applyPrototypePatch(initialDocument, patchBatch).canonicalProjection),
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Prototype ready",
      artifacts: [finalDraft],
    };
    const messages = [
      { type: "human", content: "current turn" },
      ...artifactDraftToolMessages(initialDraft, 0, "patch-initial-checkpoint"),
      ...prototypePatchToolMessages(patch, "patch-call-1"),
      ...artifactDraftToolMessages(finalDraft, 0, "patch-final-checkpoint"),
      ...validatedResultToolMessages(result, "patch-result-call"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          { id: "patch-values-1", event: "values", data: { messages } },
          { id: "patch-values-replay", event: "values", data: { messages } },
        ], { runId: "external_run_patch" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
    }), runtimeObserver)).resolves.toMatchObject({ message: "Prototype ready" });

    const patches = runtimeObserver.onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "artifact.prototype.patch");
    expect(patches).toEqual([{
      type: "artifact.prototype.patch",
      sourceEventId: expect.stringMatching(/^deerflow:[0-9a-f]{64}$/u),
      patch,
    }]);
  });

  it("keeps Prototype patch revisions stable across cumulative values frames", async () => {
    const initialDocument = minimalPrototypeDocument();
    const firstDocument = {
      ...initialDocument,
      screens: initialDocument.screens.map((screen) => ({
        ...screen,
        name: "First streamed update",
      })),
    };
    const finalDocument = {
      ...firstDocument,
      screens: firstDocument.screens.map((screen) => ({
        ...screen,
        name: "Second streamed update",
      })),
    };
    const initialDraft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: initialDocument,
      citations: [],
    };
    const firstDraft = { ...initialDraft, content: firstDocument };
    const finalDraft = { ...initialDraft, content: finalDocument };
    const firstPatchBatch = {
      screenId: "screen-home",
      baseRevision: 0,
      nextRevision: 1,
      operations: [{
        kind: "update_screen" as const,
        screenId: "screen-home",
        screen: firstDocument.screens[0]!,
      }],
      resultingChecksum: "0".repeat(64),
    };
    const firstPatch = {
      protocol: "workbench.runtime.prototype-patch.v1" as const,
      artifactIndex: 0,
      ...firstPatchBatch,
      resultingChecksum: sha256(
        applyPrototypePatch(initialDocument, firstPatchBatch).canonicalProjection,
      ),
    };
    const secondPatchBatch = {
      screenId: "screen-home",
      baseRevision: 1,
      nextRevision: 2,
      operations: [{
        kind: "update_screen" as const,
        screenId: "screen-home",
        screen: finalDocument.screens[0]!,
      }],
      resultingChecksum: "0".repeat(64),
    };
    const secondPatch = {
      protocol: "workbench.runtime.prototype-patch.v1" as const,
      artifactIndex: 0,
      ...secondPatchBatch,
      resultingChecksum: sha256(
        applyPrototypePatch(firstDocument, secondPatchBatch).canonicalProjection,
      ),
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Prototype ready",
      artifacts: [finalDraft],
    };
    const afterFirstPatch = [
      { type: "human", content: "current turn" },
      ...artifactDraftToolMessages(initialDraft, 0, "cumulative-initial-checkpoint"),
      ...prototypePatchToolMessages(firstPatch, "cumulative-patch-1"),
    ];
    const afterFirstCheckpoint = [
      ...afterFirstPatch,
      ...artifactDraftToolMessages(firstDraft, 0, "cumulative-checkpoint-2"),
    ];
    const afterSecondPatch = [
      ...afterFirstCheckpoint,
      ...prototypePatchToolMessages(secondPatch, "cumulative-patch-3"),
    ];
    const completedMessages = [
      ...afterSecondPatch,
      ...artifactDraftToolMessages(finalDraft, 0, "cumulative-final-checkpoint"),
      ...validatedResultToolMessages(result, "cumulative-result"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([
          { id: "cumulative-values-1", event: "values", data: { messages: afterFirstPatch } },
          { id: "cumulative-values-2", event: "values", data: { messages: afterFirstCheckpoint } },
          { id: "cumulative-values-3", event: "values", data: { messages: afterSecondPatch } },
          { id: "cumulative-values-4", event: "values", data: { messages: completedMessages } },
          { id: "cumulative-values-replay", event: "values", data: { messages: completedMessages } },
        ], { runId: "external_run_cumulative_patch" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
    }), runtimeObserver)).resolves.toMatchObject({ message: "Prototype ready" });

    const events = runtimeObserver.onEvent.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === "artifact.prototype.patch"))
      .toEqual([
        expect.objectContaining({ type: "artifact.prototype.patch", patch: firstPatch }),
        expect.objectContaining({ type: "artifact.prototype.patch", patch: secondPatch }),
      ]);
    expect(events.filter((event) => event.type === "artifact.draft")).toHaveLength(4);
    expect(events.filter((event) => event.type === "generation.stage")).toHaveLength(1);
  });

  it("continues Prototype patches from an active staging baseline on a new Attempt", async () => {
    const initialDocument = minimalPrototypeDocument();
    const finalDocument = {
      ...initialDocument,
      screens: initialDocument.screens.map((screen) => ({
        ...screen,
        name: "Resumed streamed update",
      })),
    };
    const finalDraft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: finalDocument,
      citations: [],
    };
    const patchBatch = {
      screenId: "screen-home",
      baseRevision: 3,
      nextRevision: 4,
      operations: [{
        kind: "update_screen" as const,
        screenId: "screen-home",
        screen: finalDocument.screens[0]!,
      }],
      resultingChecksum: "0".repeat(64),
    };
    const patch = {
      protocol: "workbench.runtime.prototype-patch.v1" as const,
      artifactIndex: 0,
      ...patchBatch,
      resultingChecksum: sha256(
        applyPrototypePatch(initialDocument, patchBatch).canonicalProjection,
      ),
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Resumed Prototype ready",
      artifacts: [finalDraft],
    };
    const messages = [
      { type: "human", content: "current resumed turn" },
      ...prototypePatchToolMessages(patch, "resumed-patch", { runtimeAttemptId: "attempt_2" }),
      ...artifactDraftToolMessages(finalDraft, 0, "resumed-checkpoint", {
        runtimeAttemptId: "attempt_2",
      }),
      ...validatedResultToolMessages(result, "resumed-result", {
        runtimeAttemptId: "attempt_2",
      }),
    ];
    let requestBody: {
      context?: { workbench?: { prototypePatchBaselines?: unknown } };
    } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        requestBody = JSON.parse(String(init.body)) as typeof requestBody;
        return runtimeStreamResponse([{
          id: "resumed-values",
          event: "values",
          data: { messages },
        }], { runId: "external_run_resumed_patch" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
    const baselineChecksum = sha256(canonicalPrototypeScreenProjection(
      projectPrototypeScreen(initialDocument, "screen-home", 3),
    ));

    await expect(adapter.execute(execution({
      attempt: 2,
      runtimeAttemptId: "attempt_2",
      resume: [{ key: "approval-1", decision: "approve" }],
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
      prototypePatchBaselines: [{
        artifactIndex: 0,
        artifactVersionId: "version-staging-1",
        document: initialDocument,
        screens: [{
          screenId: "screen-home",
          revision: 3,
          checksum: baselineChecksum,
          status: "active",
          recoveryRevision: null,
        }],
      }],
    }), runtimeObserver)).resolves.toMatchObject({ message: "Resumed Prototype ready" });

    const events = runtimeObserver.onEvent.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === "artifact.prototype.patch"))
      .toEqual([expect.objectContaining({ patch })]);
    expect(events
      .filter((event) => event.type === "artifact.draft")
      .map((event) => event.type === "artifact.draft"
        ? event.checkpointScreens.map((screen) => screen.revision)
        : [])).toEqual([[4], [4]]);
    expect(requestBody?.context?.workbench?.prototypePatchBaselines).toEqual([{
      artifactIndex: 0,
      artifactVersionId: "version-staging-1",
      screens: [{
        screenId: "screen-home",
        status: "active",
        baseRevision: 3,
        checkpointRequired: false,
      }],
    }]);
  });

  it("recovers a degraded Prototype baseline before accepting another patch", async () => {
    const initialDocument = minimalPrototypeDocument();
    const recoveredDocument = {
      ...initialDocument,
      screens: initialDocument.screens.map((screen) => ({
        ...screen,
        name: "Recovered checkpoint",
      })),
    };
    const finalDocument = {
      ...recoveredDocument,
      screens: recoveredDocument.screens.map((screen) => ({
        ...screen,
        name: "Patch after recovery",
      })),
    };
    const recoveredDraft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: recoveredDocument,
      citations: [],
    };
    const finalDraft = { ...recoveredDraft, content: finalDocument };
    const patchBatch = {
      screenId: "screen-home",
      baseRevision: 5,
      nextRevision: 6,
      operations: [{
        kind: "update_screen" as const,
        screenId: "screen-home",
        screen: finalDocument.screens[0]!,
      }],
      resultingChecksum: "0".repeat(64),
    };
    const patch = {
      protocol: "workbench.runtime.prototype-patch.v1" as const,
      artifactIndex: 0,
      ...patchBatch,
      resultingChecksum: sha256(
        applyPrototypePatch(recoveredDocument, patchBatch).canonicalProjection,
      ),
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "Recovered Prototype ready",
      artifacts: [finalDraft],
    };
    const messages = [
      { type: "human", content: "current recovery turn" },
      ...artifactDraftToolMessages(recoveredDraft, 0, "recovery-checkpoint", {
        runtimeAttemptId: "attempt_2",
      }),
      ...prototypePatchToolMessages(patch, "recovery-patch", {
        runtimeAttemptId: "attempt_2",
      }),
      ...artifactDraftToolMessages(finalDraft, 0, "recovery-final-checkpoint", {
        runtimeAttemptId: "attempt_2",
      }),
      ...validatedResultToolMessages(result, "recovery-result", {
        runtimeAttemptId: "attempt_2",
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "recovery-values",
          event: "values",
          data: { messages },
        }], { runId: "external_run_recovered_patch" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
    const baselineChecksum = sha256(canonicalPrototypeScreenProjection(
      projectPrototypeScreen(initialDocument, "screen-home", 3),
    ));

    await expect(adapter.execute(execution({
      attempt: 2,
      runtimeAttemptId: "attempt_2",
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
      prototypePatchBaselines: [{
        artifactIndex: 0,
        artifactVersionId: "version-staging-1",
        document: initialDocument,
        screens: [{
          screenId: "screen-home",
          revision: 3,
          checksum: baselineChecksum,
          status: "degraded",
          recoveryRevision: 5,
        }],
      }],
    }), runtimeObserver)).resolves.toMatchObject({ message: "Recovered Prototype ready" });

    const events = runtimeObserver.onEvent.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === "artifact.prototype.patch"))
      .toEqual([expect.objectContaining({ patch })]);
    expect(events
      .filter((event) => event.type === "artifact.draft")
      .map((event) => event.type === "artifact.draft"
        ? event.checkpointScreens.map((screen) => screen.revision)
        : [])).toEqual([[5], [6], [6]]);
  });

  it("rejects a corrupt Prototype patch baseline before contacting DeerFlow", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      prototypePatchBaselines: [{
        artifactIndex: 0,
        artifactVersionId: "version-staging-1",
        document: minimalPrototypeDocument(),
        screens: [{
          screenId: "screen-home",
          revision: 3,
          checksum: "f".repeat(64),
          status: "active",
          recoveryRevision: null,
        }],
      }],
    }), observer())).rejects.toThrow("RUNTIME_PROTOTYPE_PATCH_BASELINE_SCREEN_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Prototype patches without a prior checkpoint and after the final result", async () => {
    const patch = {
      protocol: "workbench.runtime.prototype-patch.v1" as const,
      artifactIndex: 0,
      screenId: "screen-home",
      baseRevision: 0,
      nextRevision: 1,
      operations: [{
        kind: "update_screen" as const,
        screenId: "screen-home",
        screen: minimalPrototypeDocument().screens[0]!,
      }],
      resultingChecksum: "a".repeat(64),
    };
    const draft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: minimalPrototypeDocument(),
      citations: [],
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "done",
      artifacts: [draft],
    };
    const states = [
      {
        expected: "RUNTIME_PROTOTYPE_PATCH_CHECKPOINT_MISSING",
        messages: [
          { type: "human", content: "current turn" },
          ...prototypePatchToolMessages(patch, "missing-checkpoint-patch"),
          ...validatedResultToolMessages(result, "missing-checkpoint-result"),
        ],
      },
      {
        expected: "RUNTIME_PROTOTYPE_PATCH_AFTER_RESULT",
        messages: [
          { type: "human", content: "current turn" },
          ...artifactDraftToolMessages(draft, 0, "after-result-checkpoint"),
          ...validatedResultToolMessages(result, "after-result-result"),
          ...prototypePatchToolMessages(patch, "after-result-patch"),
        ],
      },
    ];
    let streamIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        const state = states[streamIndex++];
        return runtimeStreamResponse([{
          id: `invalid-patch-${streamIndex}`,
          event: "values",
          data: { messages: state?.messages },
        }], { runId: `external_run_invalid_patch_${streamIndex}` });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));

    for (const state of states) {
      const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
      await expect(adapter.execute(execution({
        request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
      }), observer())).rejects.toThrow(state.expected);
    }
  });

  it("fails closed when a Prototype final has no checkpoint or differs from the latest checkpoint", async () => {
    const checkpoint = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: minimalPrototypeDocument(),
      citations: [],
    };
    const mismatched = { ...checkpoint, content: { ...checkpoint.content, revision: 2 } };
    const states = [
      {
        expected: "RUNTIME_ARTIFACT_DRAFT_CHECKPOINT_MISSING",
        messages: [
          { type: "human", content: "current turn" },
          ...validatedResultToolMessages({
            protocol: "workbench.runtime.result.v1",
            message: "missing checkpoint",
            artifacts: [checkpoint],
          }, "missing-checkpoint-result"),
        ],
      },
      {
        expected: "RUNTIME_ARTIFACT_DRAFT_FINAL_MISMATCH",
        messages: [
          { type: "human", content: "current turn" },
          ...artifactDraftToolMessages(checkpoint, 0, "mismatch-checkpoint"),
          ...validatedResultToolMessages({
            protocol: "workbench.runtime.result.v1",
            message: "mismatched final",
            artifacts: [mismatched],
          }, "mismatch-result"),
        ],
      },
    ];
    let streamIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        const state = states[streamIndex++];
        return runtimeStreamResponse([{
          id: `strict-final-${streamIndex}`,
          event: "values",
          data: { messages: state?.messages },
        }], { runId: `external_run_strict_${streamIndex}` });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));

    for (const state of states) {
      const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
      await expect(adapter.execute(execution({
        request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
      }), observer())).rejects.toThrow(state.expected);
    }
  });

  it("rejects undeclared and forged-scope Artifact checkpoint ToolMessages", async () => {
    const draft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: minimalPrototypeDocument(),
      citations: [],
    };
    const [, undeclared] = artifactDraftToolMessages(draft, 0, "undeclared-checkpoint");
    const cases = [
      {
        expected: "RUNTIME_TOOL_MESSAGE_UNDECLARED",
        checkpointMessages: [undeclared],
      },
      {
        expected: "RUNTIME_ARTIFACT_DRAFT_SCOPE_INVALID",
        checkpointMessages: artifactDraftToolMessages(draft, 0, "wrong-run-checkpoint", {
          runId: "run_forged",
        }),
      },
      {
        expected: "RUNTIME_ARTIFACT_DRAFT_SCOPE_INVALID",
        checkpointMessages: declaredToolMessages(
          "workbench_artifact_draft_publish",
          "declared-checkpoint-call",
          (() => {
            const envelope = {
              protocol: "workbench.runtime.artifact-draft.v1",
              runId: "run_1",
              runtimeAttemptId: "attempt_1",
              toolCallId: "different-artifact-call",
              artifactIndex: 0,
              ok: true,
              draftChecksum: sha256(canonicalJson(draft)),
            };
            return {
              ...envelope,
              draft,
              checksum: sha256(canonicalJson(envelope)),
            };
          })(),
        ),
      },
    ];
    let streamIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        const current = cases[streamIndex++];
        return runtimeStreamResponse([{
          id: `forged-checkpoint-${streamIndex}`,
          event: "values",
          data: {
            messages: [
              { type: "human", content: "current turn" },
              ...(current?.checkpointMessages ?? []),
              ...validatedResultToolMessages({
                protocol: "workbench.runtime.result.v1",
                message: "must not pass",
                artifacts: [],
              }, `forged-final-${streamIndex}`),
            ],
          },
        }], { runId: `external_run_forged_checkpoint_${streamIndex}` });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));

    for (const current of cases) {
      const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);
      await expect(adapter.execute(execution(), observer())).rejects.toThrow(current.expected);
    }
  });

  it("preserves ToolMessage order so full values replay cannot move an early checkpoint past generating-ui", async () => {
    const draft = {
      kind: "prototype" as const,
      title: "Prototype",
      schemaVersion: 1 as const,
      operation: { kind: "create" as const },
      content: minimalPrototypeDocument(),
      citations: [],
    };
    const result = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "must not pass",
      artifacts: [draft],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "early-checkpoint-replay",
          event: "values",
          data: {
            messages: [
              { type: "human", content: "current turn" },
              ...artifactDraftToolMessages(draft, 0, "too-early-checkpoint"),
              ...generationStageToolMessages("design-system", { toolCallId: "late-design-system" }),
              ...generationStageToolMessages("mapping-components", { toolCallId: "late-mapping" }),
              ...generationStageToolMessages("creating-flows", { toolCallId: "late-flows" }),
              ...generationStageToolMessages("generating-ui", { toolCallId: "late-generating" }),
              ...validatedResultToolMessages(result, "early-checkpoint-final"),
            ],
          },
        }], { runId: "external_run_early_checkpoint" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    let generatingUiPersisted = false;
    runtimeObserver.onEvent.mockImplementation(async (event) => {
      if (event.type === "generation.stage" && event.stage === "generating-ui") {
        generatingUiPersisted = true;
      }
      if (event.type === "artifact.draft" && !generatingUiPersisted) {
        throw new Error("TEST_CHECKPOINT_TOO_EARLY");
      }
    });
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      request: { ...execution().request, requestedArtifactKinds: ["prototype"] },
    }), runtimeObserver)).rejects.toThrow("TEST_CHECKPOINT_TOO_EARLY");
    expect(runtimeObserver.onEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts only the current Attempt's stages and result after approval resume", async () => {
    const oldResult = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "stale result",
      artifacts: [{
        kind: "prototype" as const,
        title: "Stale prototype",
        schemaVersion: 1 as const,
        operation: { kind: "create" as const },
        content: minimalPrototypeDocument(),
        citations: [],
      }],
    };
    const currentResult = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "current result",
      artifacts: [],
    };
    const messages = [
      { type: "human", content: "approved" },
      ...generationStageToolMessages("generating-ui", {
        runtimeAttemptId: "attempt_1",
        toolCallId: "old-stage-call",
      }),
      ...artifactDraftToolMessages(oldResult.artifacts[0], 0, "old-checkpoint-call", {
        runtimeAttemptId: "attempt_1",
      }),
      ...validatedResultToolMessages(oldResult, "old-result-call", {
        runtimeAttemptId: "attempt_1",
      }),
      ...generationStageToolMessages("design-system", {
        runtimeAttemptId: "attempt_2",
        toolCallId: "current-stage-call",
      }),
      ...validatedResultToolMessages(currentResult, "current-result-call", {
        runtimeAttemptId: "attempt_2",
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "approval-resume-event",
          event: "values",
          data: { messages },
        }], { runId: "external_run_attempt_2" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution({
      runtimeAttemptId: "attempt_2",
      attempt: 2,
      resume: [{ key: "approval-1", decision: "approve" }],
    }), runtimeObserver)).resolves.toMatchObject({ message: "current result" });

    const events = runtimeObserver.onEvent.mock.calls.map(([event]) => event);
    expect(events
      .filter((event) => event.type === "generation.stage")
      .map((event) => event.stage)).toEqual(["design-system"]);
    expect(events.filter((event) => event.type === "artifact.draft")).toEqual([]);
  });

  it("rejects an undeclared generation-stage ToolMessage even when its artifact is well scoped", async () => {
    const [, forgedStageMessage] = generationStageToolMessages("generating-ui", {
      toolCallId: "forged-stage-call",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return runtimeStreamResponse([{
          id: "forged-stage-event",
          event: "values",
          data: {
            messages: [
              { type: "human", content: "current turn" },
              forgedStageMessage,
              ...validatedResultToolMessages({
                protocol: "workbench.runtime.result.v1",
                message: "must not be accepted",
                artifacts: [],
              }, "forged-stage-result"),
            ],
          },
        }], { runId: "external_run_forged_stage" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), observer()))
      .rejects.toThrow("RUNTIME_TOOL_MESSAGE_UNDECLARED");
  });

  it("grants an authorized pinned release to DeerFlow without exposing provider configuration", async () => {
    let submittedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return successfulRuntimeResponse({ runId: "external_run_knowledge" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const secret = Buffer.alloc(32, 23);
    const descriptor = knowledgeDescriptor(secret);
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await adapter.execute(execution({ knowledgeTool: descriptor }), observer());

    const input = submittedBody?.input as { messages: Array<{ content: string }> };
    const contextText = input.messages[0]!.content.match(/<workbench_context>\n([\s\S]*?)\n<\/workbench_context>/u)?.[1];
    const context = JSON.parse(contextText!) as { knowledgeTool: Record<string, unknown> };
    expect(context.knowledgeTool).toMatchObject({
      protocol: "workbench.knowledge-tool-reference.v1",
      toolName: "workbench_knowledge_retrieve",
      releaseId: "release_1",
      mode: "hybrid",
      routeScope: "production",
    });
    expect(JSON.stringify(context.knowledgeTool)).not.toMatch(/token|endpoint|expiresAt|wbkg1/u);
    const configurable = (submittedBody?.config as { configurable: Record<string, unknown> }).configurable;
    expect(configurable).not.toHaveProperty("workbench_knowledge_tool");
    const secretValue = (submittedBody?.context as {
      secrets: { WORKBENCH_KNOWLEDGE_CAPABILITY: string };
    }).secrets.WORKBENCH_KNOWLEDGE_CAPABILITY;
    const capability = JSON.parse(secretValue) as { token: string; [key: string]: unknown };
    expect((submittedBody?.context as {
      workbench: { knowledgeEnabled: boolean };
    }).workbench.knowledgeEnabled).toBe(true);
    expect(JSON.stringify(submittedBody?.input)).not.toMatch(/wbkg1|runtime\/knowledge\/retrieve/u);
    expect(JSON.stringify(submittedBody?.metadata)).not.toMatch(/wbkg1|runtime\/knowledge\/retrieve/u);
    expect(JSON.stringify(submittedBody).match(/wbkg1\./gu)).toHaveLength(1);
    expect(capability).toMatchObject({
      protocol: "workbench.knowledge-tool.v1",
      endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
      releaseId: "release_1",
      mode: "hybrid",
      routeScope: "production",
    });
    expect(verifyKnowledgeToolGrant(capability.token, secret)).toMatchObject({
      runId: "run_1",
      runtimeAttemptId: "attempt_1",
      principalId: "principal_1",
      projectId: "project_1",
      releaseId: "release_1",
      mode: "hybrid",
      routeScope: "production",
    });
    expect(JSON.stringify(capability)).not.toContain("provider");
  });

  it("never derives or signs a Knowledge capability inside the transport adapter", async () => {
    let submittedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return successfulRuntimeResponse({ runId: "external_run_without_knowledge" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter({
      ...workerConfig(),
      knowledgeTool: {
        endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
        secret: Buffer.alloc(32, 17),
        maximumTtlSeconds: 900,
      },
    }, { getObject: vi.fn() } as never);

    await expect(adapter.execute(execution(), runtimeObserver)).resolves.toMatchObject({
      protocol: "workbench.runtime.result.v1",
    });
    expect(submittedBody).toMatchObject({
      context: {
        workbench: {
          runId: "run_1",
          runtimeAttemptId: "attempt_1",
        },
      },
    });
    expect((submittedBody?.context as Record<string, unknown>)).not.toHaveProperty("secrets");
    expect((submittedBody?.context as {
      workbench: Record<string, unknown>;
    }).workbench).not.toHaveProperty("knowledgeEnabled");
    expect(JSON.stringify(submittedBody)).not.toMatch(/WORKBENCH_KNOWLEDGE_CAPABILITY|wbkg1/u);
  });

  it("sends the persisted materialized Design System snapshot instead of a live Artifact reference", async () => {
    let submittedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return successfulRuntimeResponse({
          runId: "external_run_style",
          artifacts: [minimalPrototypeArtifact()],
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const snapshot = {
      protocol: "workbench.runtime.design-style.v1" as const,
      source: {
        projectId: "project_1",
        artifactId: "artifact_style",
        artifactVersionId: "version_style",
        checksum: "a".repeat(64),
      },
      documentId: "design-main",
      title: "Product UI",
      tokens: [{
        id: "token-primary",
        path: "color.primary",
        type: "color" as const,
        value: "#112233",
        description: null,
      }],
      assets: [],
      principles: [],
      guidelines: [],
      components: [],
    };
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    await adapter.execute(execution({
      request: {
        ...execution().request,
        generationIntent: "interactive-prototype",
        designStyle: { kind: "artifact", artifactVersionId: "version_style" },
        artifactTargets: [
          { artifactId: "artifact_prototype", artifactVersionId: "version_prototype", screenIds: ["screen-home"] },
        ],
        requestedArtifactKinds: ["prototype"],
      },
      artifactTargets: [
        {
          artifactId: "artifact_prototype",
          artifactVersionId: "version_prototype",
          screenIds: ["screen-home"],
          kind: "prototype",
          schemaVersion: 1,
          checksum: sha256(canonicalJson(minimalPrototypeDocument())),
          content: { mode: "inline", value: minimalPrototypeDocument() },
          assets: [],
        },
      ],
      designStyleSnapshot: snapshot,
    }), observer());

    const input = submittedBody?.input as { messages: Array<{ content: string }> };
    const contextText = input.messages[0]!.content.match(/<workbench_context>\n([\s\S]*?)\n<\/workbench_context>/)?.[1];
    expect(contextText).toBeDefined();
    const context = JSON.parse(contextText!);
    expect(context.designStyle).toMatchObject({
      kind: "materialized",
      snapshot: {
        protocol: "workbench.runtime.design-style.v1",
        tokens: [{ path: "color.primary", value: "#112233" }],
      },
    });
    expect(context.designStyle.artifactVersionId).toBeUndefined();
    expect(context.artifactTargets).toMatchObject([
      {
        artifactId: "artifact_prototype",
        artifactVersionId: "version_prototype",
        screenIds: ["screen-home"],
        kind: "prototype",
        content: { mode: "inline" },
        assets: [],
      },
    ]);
    expect((submittedBody?.config as {
      configurable: { subagent_enabled: boolean };
    }).configurable.subagent_enabled).toBe(true);
  });

  it("joins an existing SDK run with Last-Event-ID and never submits a duplicate", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === "/api/threads/deer_thread_1/runs/external_run_1") {
        return Response.json(runtimeRun("external_run_1"));
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/external_run_1/stream") {
        return successfulRuntimeResponse({
          runId: "external_run_1",
          eventId: "event-existing-2",
          includeContentLocation: false,
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    const result = await adapter.execute(execution({
      submission: {
        mode: "join",
        providerIdempotencyKey: "wbrt:test-attempt-key",
        externalRunId: "external_run_1",
        lastExternalEventId: "event-existing-1",
      },
    }), runtimeObserver);

    expect(result).toMatchObject({ protocol: "workbench.runtime.result.v1", message: "done" });
    const joinRequest = requests.find((request) => request.url.pathname.endsWith("/stream"));
    expect(joinRequest?.init.method).toBe("GET");
    expect(new Headers(joinRequest?.init.headers).get("Last-Event-ID")).toBe("event-existing-1");
    expect(joinRequest?.url.searchParams.get("cancel_on_disconnect")).toBe("0");
    expect(requests.some((request) => request.init.method === "POST")).toBe(false);
    expect(runtimeObserver.onSubmissionStarted).not.toHaveBeenCalled();
    expect(runtimeObserver.onExternalRunCreated).not.toHaveBeenCalled();
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRunId: "external_run_1",
        externalEventId: "event-existing-2",
      }),
      expect.any(Array),
    );
  });

  it("recovers a missing externalRunId by attempt metadata and joins without another POST", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === "/api/threads/deer_thread_1/runs") {
        return Response.json([runtimeRun("external_run_recovered", {
          workbench_runtime_attempt_id: "attempt_1",
        })]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/external_run_recovered/stream") {
        return successfulRuntimeResponse({
          runId: "external_run_recovered",
          eventId: "event-recovered-1",
          includeContentLocation: false,
        });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeObserver = observer();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    const result = await adapter.execute(execution(), runtimeObserver);

    expect(result).toMatchObject({ protocol: "workbench.runtime.result.v1", message: "done" });
    expect(requests[0]?.url.searchParams.get("limit")).toBe("100");
    expect(requests[0]?.url.searchParams.get("offset")).toBe("0");
    expect(requests.some((request) => request.init.method === "POST")).toBe(false);
    expect(runtimeObserver.onSubmissionStarted).toHaveBeenCalledTimes(1);
    expect(runtimeObserver.onExternalRunCreated).toHaveBeenCalledWith("external_run_recovered");
    expect(runtimeObserver.onExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRunId: "external_run_recovered",
        externalEventId: "event-recovered-1",
      }),
      expect.any(Array),
    );
  });

  it("cancels a non-terminal run through the official SDK cancel endpoint", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === "/api/threads/deer_thread_1/runs/external_run_1") {
        return Response.json(runtimeRun("external_run_1"));
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/external_run_1/cancel") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const recovered = vi.fn(async () => undefined);
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    const result = await adapter.cancel({
      runId: "run_1",
      runtimeAttemptId: "attempt_1",
      principalId: "principal_1",
      externalThreadId: "deer_thread_1",
      externalRunId: "external_run_1",
    }, recovered);

    expect(result).toEqual({
      externalRunId: "external_run_1",
      externalStatus: "interrupted",
      found: true,
    });
    const cancelRequest = requests.at(-1);
    expect(cancelRequest?.url.pathname).toBe("/api/threads/deer_thread_1/runs/external_run_1/cancel");
    expect(cancelRequest?.url.searchParams.get("wait")).toBe("1");
    expect(cancelRequest?.url.searchParams.get("action")).toBe("interrupt");
    expect(cancelRequest?.init.method).toBe("POST");
    expect(recovered).not.toHaveBeenCalled();
  });

  it("creates DeerFlow threads with a stable deterministic UUID", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/threads" || init.method !== "POST") {
        throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
      }
      const body = JSON.parse(String(init.body)) as {
        thread_id: string;
        metadata: Record<string, unknown>;
      };
      bodies.push(body);
      return Response.json({ thread_id: body.thread_id, metadata: body.metadata });
    });
    vi.stubGlobal("fetch", fetchMock);
    const metadata = {
      workbenchProjectId: "project_1",
      workbenchThreadId: "thread_1",
      workbenchPrincipalId: "principal_1",
    };
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), { getObject: vi.fn() } as never);

    const first = await adapter.createThread(metadata);
    const second = await adapter.createThread(metadata);

    expect(runtimeThreadUuid("thread_1")).toBe("da491c6b-e364-5c98-aea1-df13a2b09bb5");
    expect(first.externalThreadId).toBe("da491c6b-e364-5c98-aea1-df13a2b09bb5");
    expect(second.externalThreadId).toBe(first.externalThreadId);
    expect(bodies).toEqual([
      { thread_id: first.externalThreadId, if_exists: "do_nothing", metadata },
      { thread_id: first.externalThreadId, if_exists: "do_nothing", metadata },
    ]);
  });

  it("sends decisions through DeerFlow command.resume", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        return successfulRuntimeResponse({ message: "resumed" });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const storage = { getObject: vi.fn() };
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), storage as never);
    const runtimeObserver = observer();

    const result = await adapter.execute(execution({
      request: {
        prompt: "Original prompt",
        modelId: "quality",
        workflow: "generate",
        targetSurface: "app",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        artifactTargets: [],
        requestedArtifactKinds: [],
      },
      sources: [{
        position: 0,
        blobId: "blob-must-not-upload",
        originalName: "must-not-upload.txt",
        mediaType: "text/plain",
        byteSize: 4,
        sha256: "a".repeat(64),
        original: {
          storageKey: "private/must-not-read",
          mediaType: "text/plain",
          byteSize: 4,
          sha256: "a".repeat(64),
        },
        extraction: null,
      }],
      designAssets: [{
        assetId: "must-not-upload",
        name: "Must not upload",
        kind: "image",
        artifactVersionId: "version-style",
        blobId: "blob-design-must-not-upload",
        mediaType: "image/png",
        byteSize: 4,
        sha256: "b".repeat(64),
        content: {
          storageKey: "private/design-must-not-read",
          mediaType: "image/png",
          byteSize: 4,
          sha256: "b".repeat(64),
        },
      }],
      knowledgeTool: null,
      resume: [{ key: "interrupt_1", decision: "approve" }],
    }), runtimeObserver);

    expect(result).toMatchObject({ protocol: "workbench.runtime.result.v1", message: "resumed" });
    const init = fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1];
    expect(init).toBeDefined();
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: null,
      command: { resume: { approved: true } },
      context: {
        workbench: {
          runId: "run_1",
          runtimeAttemptId: "attempt_1",
        },
      },
    });
    const headers = new Headers(init.headers);
    const csrfToken = headers.get("X-CSRF-Token");
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(headers.get("Cookie")).toBe(`csrf_token=${csrfToken}`);
    expect(headers.get("X-DeerFlow-Internal-Token")).toBe("internal");
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeObserver.onExternalRunCreated).toHaveBeenCalledWith("external_run_1");
  });

  it("streams multipart bytes and refuses a mismatched digest before finalizing the body", async () => {
    const content = Buffer.from("streamed source");
    const multipart = createMultipartUploadStream({
      source: Readable.from([content.subarray(0, 5), content.subarray(5)]) as never,
      fileName: "需求 brief.txt",
      mediaType: "text/plain",
      byteSize: content.byteLength,
      sha256: sha256(content),
    });
    const encoded = await readNodeBody(multipart.body);
    expect(encoded.byteLength).toBe(multipart.contentLength);
    expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=-+[a-f0-9]+$/);
    expect(encoded.toString()).toContain('filename="需求 brief.txt"');
    expect(encoded.toString()).toContain("streamed source");

    const corrupted = createMultipartUploadStream({
      source: Readable.from([content]) as never,
      fileName: "brief.txt",
      mediaType: "text/plain",
      byteSize: content.byteLength,
      sha256: "0".repeat(64),
    });
    await expect(readNodeBody(corrupted.body)).rejects.toThrow("RUNTIME_SOURCE_STORAGE_DIGEST_MISMATCH");
  });

  it("is accepted as a streaming request body by the Node fetch implementation", async () => {
    let received = Buffer.alloc(0);
    const server = createServer(async (request, response) => {
      received = await readNodeBody(request);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address missing");
      const content = Buffer.from("native fetch stream");
      const multipart = createMultipartUploadStream({
        source: Readable.from([content]) as never,
        fileName: "native.txt",
        mediaType: "text/plain",
        byteSize: content.byteLength,
        sha256: sha256(content),
      });
      const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
        method: "POST",
        headers: {
          "content-type": multipart.contentType,
          "content-length": String(multipart.contentLength),
        },
        body: multipart.body as unknown as BodyInit,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      expect(response.status).toBe(204);
      expect(received.byteLength).toBe(multipart.contentLength);
      expect(received.includes(content)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uploads immutable original and extraction streams and sends only safe handles to DeerFlow", async () => {
    const original = Buffer.from("original private bytes");
    const extracted = Buffer.from("# Extracted text");
    const bodies = new Map([
      ["tenant/private/original", original],
      ["tenant/private/extracted", extracted],
    ]);
    const storage = {
      getObject: vi.fn(async (locator: { storageKey: string; byteSize: number }) => {
        const body = bodies.get(locator.storageKey);
        if (!body) throw new Error("missing test object");
        return {
          body: Readable.from([body.subarray(0, 3), body.subarray(3)]),
          byteSize: locator.byteSize,
          mediaType: null,
        };
      }),
    };
    const uploads: Array<{ url: string; body: Buffer; headers: Headers }> = [];
    let runRequest: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const requestUrl = String(input);
      const url = new URL(requestUrl);
      if (requestUrl.startsWith("http://gateway.test/")) {
        const body = await readNodeBody(init.body as unknown as Readable);
        uploads.push({ url: requestUrl, body, headers: new Headers(init.headers) });
        const index = uploads.length;
        return Response.json({
          files: [{
            virtual_path: `/mnt/user-data/uploads/upload-${index}.bin`,
            markdown_virtual_path: `/mnt/user-data/uploads/upload-${index}.md`,
            artifact_url: "https://must-not-leak.example/private",
          }],
        });
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        runRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
        return successfulRuntimeResponse();
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), storage as never);
    const presetSnapshot = runtimePresetSnapshot();

    await adapter.execute(execution({
      request: {
        prompt: "Use the attached brief",
        modelId: "quality",
        workflow: "redesign",
        targetSurface: "web",
        designStyle: { kind: "preset", ...presetSnapshot.source },
        sourceIds: ["file-id-must-not-leak"],
        artifactTargets: [],
        requestedArtifactKinds: [],
      },
      sources: [{
        position: 0,
        blobId: "blob-brief",
        originalName: "brief.pdf",
        mediaType: "application/pdf",
        byteSize: original.byteLength,
        sha256: sha256(original),
        original: {
          storageKey: "tenant/private/original",
          mediaType: "application/pdf",
          byteSize: original.byteLength,
          sha256: sha256(original),
        },
        extraction: {
          kind: "text",
          position: 0,
          content: {
            storageKey: "tenant/private/extracted",
            mediaType: "text/markdown",
            byteSize: extracted.byteLength,
            sha256: sha256(extracted),
          },
        },
      }],
      knowledgeTool: null,
      designStyleSnapshot: presetSnapshot,
      resume: null,
    }), observer());

    expect(storage.getObject).toHaveBeenCalledTimes(2);
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.url).toBe("http://gateway.test/api/threads/deer_thread_1/uploads");
      expect(upload.headers.get("X-DeerFlow-Owner-User-Id")).toBe("principal_1");
      expect(upload.headers.get("X-DeerFlow-Internal-Token")).toBe("internal");
      expect(Number(upload.headers.get("content-length"))).toBe(upload.body.byteLength);
      expect(upload.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    }
    expect(uploads[0]?.body.includes(original)).toBe(true);
    expect(uploads[1]?.body.includes(extracted)).toBe(true);
    const serialized = JSON.stringify(runRequest);
    expect(serialized).toContain("/mnt/user-data/uploads/upload-1.bin");
    expect(serialized).toContain("/mnt/user-data/uploads/upload-2.md");
    expect(serialized).toContain('\\"workflow\\":\\"redesign\\"');
    expect(serialized).toContain('\\"targetSurface\\":\\"web\\"');
    expect(serialized).toContain('\\"designStyle\\":{\\"kind\\":\\"materialized\\"');
    expect(serialized).toContain("workbench.runtime.design-preset.v1");
    expect(serialized).toContain("workbench.bauhaus");
    expect(serialized).not.toContain("file-id-must-not-leak");
    expect(serialized).not.toContain("tenant/private");
    expect(serialized).not.toContain("must-not-leak.example");
    expect(serialized).not.toContain("artifact_url");
  });

  it("commits integrity evidence before rejecting corrupted S3 bytes and sends zero provider POSTs", async () => {
    const expected = Buffer.from("trusted runtime source");
    const tampered = Buffer.from("TAMPERED runtime sourc");
    expect(tampered.byteLength).toBe(expected.byteLength);
    let recorderResolved = false;
    const recordIntegrityFailure = vi.fn(async () => {
      await Promise.resolve();
      recorderResolved = true;
    });
    const s3 = {
      send: vi.fn(async () => ({
        Body: Readable.from([tampered.subarray(0, 4), tampered.subarray(4)]),
        ContentLength: tampered.byteLength,
        ContentType: "text/plain",
      })),
    };
    const storage = new S3RuntimeReadyBlobReader(
      workerConfig(),
      recordIntegrityFailure,
      s3 as never,
    );
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/api/threads/deer_thread_1/runs") && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      throw new Error(`Provider request must not occur before ready-object verification: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), storage);
    const presetSnapshot = runtimePresetSnapshot();

    let rejection: unknown;
    try {
      await adapter.execute(execution({
        request: {
          prompt: "Use the attached brief",
          modelId: "quality",
          workflow: "redesign",
          targetSurface: "web",
          designStyle: { kind: "preset", ...presetSnapshot.source },
          sourceIds: ["file-corrupted"],
          artifactTargets: [],
          requestedArtifactKinds: [],
        },
        sources: [{
          position: 0,
          sourceId: "file-corrupted",
          sourceKind: "file",
          blobId: "blob-corrupted",
          originalName: "brief.txt",
          mediaType: "text/plain",
          byteSize: expected.byteLength,
          sha256: sha256(expected),
          original: {
            storageKey: "blobs/corrupted-runtime-source",
            mediaType: "text/plain",
            byteSize: expected.byteLength,
            sha256: sha256(expected),
          },
          extraction: null,
        }],
        knowledgeTool: null,
        designStyleSnapshot: presetSnapshot,
        resume: null,
      }), observer());
    } catch (error) {
      rejection = error;
      expect(recorderResolved).toBe(true);
    }

    expect(rejection).toMatchObject({ message: "RUNTIME_SOURCE_STORAGE_READ_FAILED" });
    expect(recordIntegrityFailure).toHaveBeenCalledOnce();
    expect(recordIntegrityFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
      storageKey: "blobs/corrupted-runtime-source",
      observedSha256: sha256(tampered),
    }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("uploads pinned Design System assets and exposes only asset-to-handle mappings", async () => {
    const image = Buffer.from("private brand image");
    const storage = {
      getObject: vi.fn(async (locator: { storageKey: string; byteSize: number }) => ({
        body: Readable.from([image]),
        byteSize: locator.byteSize,
        mediaType: null,
      })),
    };
    const uploads: Buffer[] = [];
    let runRequest: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const requestUrl = String(input);
      const url = new URL(requestUrl);
      if (requestUrl.startsWith("http://gateway.test/")) {
        uploads.push(await readNodeBody(init.body as unknown as Readable));
        return Response.json({
          files: [{
            virtual_path: "/mnt/user-data/uploads/design-brand.png",
            markdown_virtual_path: "/mnt/user-data/uploads/design-brand.md",
            storage_key: "must-not-leak",
          }],
        });
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        runRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
        return successfulRuntimeResponse();
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const asset = {
      id: "brand-mark",
      name: "Brand / mark",
      kind: "image" as const,
      artifactVersionId: "version-style",
      blobId: "blob-brand",
      mediaType: "image/png",
      byteSize: image.byteLength,
      sha256: sha256(image),
    };
    const snapshot = {
      protocol: "workbench.runtime.design-style.v1" as const,
      source: {
        projectId: "project_1",
        artifactId: "artifact_style",
        artifactVersionId: "version-style",
        checksum: "a".repeat(64),
      },
      documentId: "design-main",
      title: "Product UI",
      tokens: [],
      assets: [asset],
      principles: [],
      guidelines: [],
      components: [],
    };
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), storage as never);

    await adapter.execute(execution({
      request: {
        ...execution().request,
        designStyle: { kind: "artifact", artifactVersionId: "version-style" },
      },
      designStyleSnapshot: snapshot,
      designAssets: [{
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        artifactVersionId: asset.artifactVersionId,
        blobId: asset.blobId,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
        content: {
          storageKey: "tenant/private/design-brand",
          mediaType: asset.mediaType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
        },
      }],
    }), observer());

    expect(storage.getObject).toHaveBeenCalledWith({
      storageKey: "tenant/private/design-brand",
      mediaType: "image/png",
      byteSize: image.byteLength,
      sha256: sha256(image),
    }, expect.any(AbortSignal));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.includes(image)).toBe(true);
    const input = runRequest?.input as { messages: Array<{ content: string }> };
    const contextText = input.messages[0]!.content.match(/<workbench_context>\n([\s\S]*?)\n<\/workbench_context>/)?.[1];
    const context = JSON.parse(contextText!);
    expect(context.designStyle).toMatchObject({
      kind: "materialized",
      snapshot: { assets: [{ id: "brand-mark", blobId: "blob-brand" }] },
      assetHandles: {
        "brand-mark": {
          virtualPath: "/mnt/user-data/uploads/design-brand.png",
          markdownVirtualPath: "/mnt/user-data/uploads/design-brand.md",
        },
      },
    });
    const serialized = JSON.stringify(runRequest);
    expect(serialized).not.toContain("tenant/private");
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("deduplicates target asset uploads and exposes scoped handles without storage locators", async () => {
    const image = Buffer.from("shared source image");
    const digest = sha256(image);
    const locator = {
      storageKey: "tenant/private/source-image",
      mediaType: "image/png",
      byteSize: image.byteLength,
      sha256: digest,
    };
    const storage = {
      getObject: vi.fn(async () => ({
        body: Readable.from([image]),
        byteSize: image.byteLength,
        mediaType: "image/png",
      })),
    };
    const uploads: Buffer[] = [];
    let runRequest: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const requestUrl = String(input);
      const url = new URL(requestUrl);
      if (requestUrl.startsWith("http://gateway.test/")) {
        uploads.push(await readNodeBody(init.body as unknown as Readable));
        return Response.json({
          files: [{
            virtual_path: "/mnt/user-data/uploads/source-image.png",
            storage_key: "must-not-leak",
          }],
        });
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs" && (init.method ?? "GET") === "GET") {
        return Response.json([]);
      }
      if (url.pathname === "/api/threads/deer_thread_1/runs/stream" && init.method === "POST") {
        runRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
        return successfulRuntimeResponse({ artifacts: [minimalPrototypeArtifact()] });
      }
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    }));
    const targetSpecs = [
      { artifactId: "artifact-source-a", artifactVersionId: "version-source-a", assetId: "hero-a" },
      { artifactId: "artifact-source-b", artifactVersionId: "version-source-b", assetId: "hero-b" },
    ];
    const document = minimalPrototypeDocument();
    const adapter = new DeerFlowRuntimeAdapter(workerConfig(), storage as never);

    await adapter.execute(execution({
      request: {
        ...execution().request,
        generationIntent: "interactive-prototype",
        requestedArtifactKinds: ["prototype"],
        artifactTargets: targetSpecs.map((target) => ({
          artifactId: target.artifactId,
          artifactVersionId: target.artifactVersionId,
          screenIds: ["screen-home"],
        })),
      },
      artifactTargets: targetSpecs.map((target) => {
        const metadata = {
          id: target.assetId,
          kind: "image" as const,
          name: `Source ${target.assetId}`,
          blobId: "blob-shared-image",
          mediaType: "image/png" as const,
          byteSize: image.byteLength,
          sha256: digest,
          width: 320,
          height: 180,
        };
        return {
          artifactId: target.artifactId,
          artifactVersionId: target.artifactVersionId,
          screenIds: ["screen-home"],
          kind: "prototype" as const,
          schemaVersion: 1,
          checksum: sha256(canonicalJson(document)),
          content: { mode: "inline" as const, value: document },
          assets: [{
            artifactVersionId: target.artifactVersionId,
            assetId: target.assetId,
            kind: metadata.kind,
            blobId: metadata.blobId,
            mediaType: metadata.mediaType,
            byteSize: metadata.byteSize,
            sha256: metadata.sha256,
            metadata,
            content: locator,
          }],
        };
      }),
    }), observer());

    expect(storage.getObject).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.includes(image)).toBe(true);
    const input = runRequest?.input as { messages: Array<{ content: string }> };
    const contextText = input.messages[0]!.content.match(/<workbench_context>\n([\s\S]*?)\n<\/workbench_context>/)?.[1];
    const context = JSON.parse(contextText!);
    expect(context.artifactTargets).toMatchObject([
      {
        artifactVersionId: "version-source-a",
        assets: [{
          id: "hero-a",
          blobId: "blob-shared-image",
          width: 320,
          handle: { virtualPath: "/mnt/user-data/uploads/source-image.png" },
        }],
      },
      {
        artifactVersionId: "version-source-b",
        assets: [{
          id: "hero-b",
          blobId: "blob-shared-image",
          width: 320,
          handle: { virtualPath: "/mnt/user-data/uploads/source-image.png" },
        }],
      },
    ]);
    const serialized = JSON.stringify(runRequest);
    expect(serialized).not.toContain("tenant/private");
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("accepts only upload-scoped DeerFlow virtual paths", () => {
    expect(normalizeUploadVirtualPath("mnt/user-data/uploads/brief.md"))
      .toBe("/mnt/user-data/uploads/brief.md");
    expect(() => normalizeUploadVirtualPath("https://evil.example/file"))
      .toThrow("DEERFLOW_UPLOAD_HANDLE_INVALID");
    expect(() => normalizeUploadVirtualPath("/mnt/user-data/uploads/%2e%2e/secret"))
      .toThrow("DEERFLOW_UPLOAD_HANDLE_INVALID");
    expect(() => normalizeUploadVirtualPath("/mnt/user-data/outputs/secret"))
      .toThrow("DEERFLOW_UPLOAD_HANDLE_INVALID");
  });
});

async function readNodeBody(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function successfulRuntimeResponse({
  runId = "external_run_1",
  eventId = "event-1",
  includeContentLocation = true,
  message = "done",
  assistantText = message,
  artifacts = [],
}: {
  runId?: string;
  eventId?: string;
  includeContentLocation?: boolean;
  message?: string;
  assistantText?: string;
  artifacts?: unknown[];
} = {}) {
  return runtimeStreamResponse([{
    id: eventId,
    event: "values",
    data: {
      messages: [
        { type: "human", content: "current turn" },
        ...artifacts.flatMap((artifact, artifactIndex) => (
          artifactDraftToolMessages(artifact, artifactIndex, `successful-artifact-${artifactIndex}`)
        )),
        ...validatedResultToolMessages({
          protocol: "workbench.runtime.result.v1",
          message,
          artifacts,
        }),
        { type: "ai", content: assistantText },
      ],
    },
  }], { runId, includeContentLocation });
}

function minimalPrototypeArtifact() {
  return {
    kind: "prototype" as const,
    schemaVersion: 1 as const,
    title: "Generated Prototype",
    citations: [],
    operation: { kind: "create" as const },
    content: minimalPrototypeDocument(),
  };
}

function runtimeStreamResponse(
  parts: Array<{ id?: string; event: string; data: unknown }>,
  {
    runId = "external_run_1",
    includeContentLocation = true,
  }: {
    runId?: string;
    includeContentLocation?: boolean;
  } = {},
) {
  return new Response(new ReadableStream({
    start(controller) {
      const lines = parts.flatMap((part) => [
        ...(part.id ? [`id: ${part.id}`] : []),
        `event: ${part.event}`,
        `data: ${JSON.stringify(part.data)}`,
        "",
      ]);
      controller.enqueue(new TextEncoder().encode([...lines, ""].join("\n")));
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...(includeContentLocation
        ? { "content-location": `/threads/deer_thread_1/runs/${runId}` }
        : {}),
    },
  });
}

function runtimeRun(
  runId: string,
  metadata: Record<string, unknown> = {},
) {
  return {
    run_id: runId,
    thread_id: "deer_thread_1",
    status: "running",
    metadata: {
      workbench_runtime_attempt_id: "attempt_1",
      workbench_provider_idempotency_key: "wbrt:test-attempt-key",
      ...metadata,
    },
  };
}

function minimalPrototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-doc",
    title: "Prototype",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "frame-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: "frame-home",
      screenId: "screen-home",
      parentId: null,
      name: "Home frame",
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
        radii: {
          topLeft: literal(0),
          topRight: literal(0),
          bottomRight: literal(0),
          bottomLeft: literal(0),
        },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame" as const,
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function minimalPrdDocument(): PrdDocument {
  const text = (value: string) => [{ type: "text" as const, text: value, marks: [] }];

  return {
    protocol: "workbench.prd.v1",
    documentId: "prd-doc",
    title: "PRD",
    revision: {
      number: 1,
      status: "draft",
      summary: "Initial test revision",
      changedAt: "2026-07-12T00:00:00.000Z",
      changedById: null,
    },
    assumptions: [],
    citations: [],
    sections: {
      executiveSummary: {
        title: "Executive summary",
        blocks: [{ id: "summary", type: "paragraph", content: text("Summary") }],
      },
      problem: {
        title: "Problem",
        blocks: [{ id: "problem", type: "paragraph", content: text("Problem") }],
      },
      goals: {
        title: "Goals",
        blocks: [{
          id: "goal-main",
          type: "goal",
          title: "Main goal",
          description: text("Goal description"),
          successMetric: "A measurable result",
          priority: "primary",
        }],
      },
      targetUsers: {
        title: "Target users",
        blocks: [{
          id: "persona-main",
          type: "persona",
          name: "Primary user",
          description: text("User description"),
          needs: ["Complete the workflow"],
          painPoints: ["Current workflow is slow"],
        }],
      },
      scope: {
        title: "Scope",
        blocks: [{
          id: "scope-list",
          type: "bulletList",
          items: [{ id: "scope-item", content: text("In scope") }],
        }],
      },
      requirements: {
        title: "Requirements",
        blocks: [{
          id: "requirement-main",
          type: "requirement",
          title: "Core requirement",
          description: text("Requirement description"),
          priority: "must",
          goalIds: ["goal-main"],
          acceptanceCriterionIds: ["criterion-main"],
        }],
      },
      userFlows: {
        title: "User flows",
        blocks: [{
          id: "flow-main",
          type: "flow",
          title: "Primary flow",
          actor: "Primary user",
          trigger: "Starts the workflow",
          steps: [{ id: "flow-step", text: "Complete the action", requirementIds: ["requirement-main"] }],
          outcome: "The workflow completes",
        }],
      },
      acceptanceCriteria: {
        title: "Acceptance criteria",
        blocks: [{
          id: "criterion-main",
          type: "acceptanceCriterion",
          requirementIds: ["requirement-main"],
          given: text("Given valid input"),
          when: text("When the user submits"),
          then: text("Then the action succeeds"),
        }],
      },
      risksAndDependencies: {
        title: "Risks and dependencies",
        blocks: [{
          id: "risk-main",
          type: "risk",
          description: text("Delivery risk"),
          likelihood: "low",
          impact: "medium",
          mitigation: text("Monitor the dependency"),
        }],
      },
    },
  };
}
