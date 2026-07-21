import { loadWorkerConfig, pgConnectionString } from "../src/config.js";

describe("worker database configuration", () => {
  beforeEach(() => {
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID", "runtime-access");
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY", "runtime-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("removes the Prisma schema query parameter for pg-boss", () => {
    expect(pgConnectionString("postgresql://user:pass@localhost:5432/db?schema=workbench&sslmode=require"))
      .toBe("postgresql://user:pass@localhost:5432/db?sslmode=require");
  });

  it("requires separate DeerFlow Gateway and S3 runtime content configuration", () => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_S3_INTERNAL_ENDPOINT", "http://127.0.0.1:9000/");
    vi.stubEnv("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE", "true");
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID", "runtime-access");
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY", "runtime-secret");
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_URL", "https://workbench.test/api/v1/runtime/knowledge/retrieve");
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_SECRET", Buffer.alloc(32, 7).toString("base64url"));
    vi.stubEnv("WORKBENCH_CANVAS_TOOL_URL", "https://workbench.test/api/v1/runtime/canvas/tools/execute");
    vi.stubEnv("WORKBENCH_CANVAS_VISUAL_URL", "https://workbench.test/api/v1/runtime/canvas/visuals");
    vi.stubEnv("WORKBENCH_CANVAS_TOOL_SECRET", Buffer.alloc(32, 8).toString("base64url"));
    try {
      expect(loadWorkerConfig()).toMatchObject({
        deerFlowLangGraphUrl: "https://deerflow.test/api",
        deerFlowGatewayUrl: "https://deerflow.test",
        s3Bucket: "workbench",
        s3InternalEndpoint: "http://127.0.0.1:9000",
        s3ForcePathStyle: true,
        runtimeReadyBlobS3AccessKeyId: "runtime-access",
        runtimeExecutionLeaseMs: 45_000,
        runtimeExecutionHeartbeatMs: 15_000,
        runtimeExecutionReconcileIntervalMs: 5_000,
        runtimeExecutionReconcileBatchSize: 100,
        concurrency: 2,
        runtimeCancellationPollIntervalMs: 1_000,
        runtimeCancellationQueryBatchSize: 100,
        knowledgeTool: {
          endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
          maximumTtlSeconds: 900,
        },
        canvasTool: {
          endpoint: "https://workbench.test/api/v1/runtime/canvas/tools/execute",
          visualEndpoint: "https://workbench.test/api/v1/runtime/canvas/visuals",
          maximumTtlSeconds: 300,
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["WORKBENCH_RUNTIME_CONCURRENCY", "65"],
    ["WORKBENCH_RUNTIME_CANCELLATION_POLL_INTERVAL_MS", "249"],
    ["WORKBENCH_RUNTIME_CANCELLATION_QUERY_BATCH_SIZE", "1001"],
  ])("rejects an unbounded %s value", (name, value) => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv(name, value);
    expect(() => loadWorkerConfig()).toThrow(new RegExp(`${name} must be an integer between`, "u"));
  });

  it("fails closed instead of using generic or ambient S3 credentials", () => {
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID", "");
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY", "");
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-access");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    try {
      expect(() => loadWorkerConfig()).toThrow("Missing WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a heartbeat interval that cannot renew safely before lease expiry", () => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_RUNTIME_EXECUTION_LEASE_MS", "30000");
    vi.stubEnv("WORKBENCH_RUNTIME_EXECUTION_HEARTBEAT_MS", "15000");

    expect(() => loadWorkerConfig()).toThrow(/less than half the execution lease/u);
  });

  it("requires the Knowledge tool endpoint and signing secret as one configuration unit", () => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_URL", "https://workbench.test/api/v1/runtime/knowledge/retrieve");
    try {
      expect(() => loadWorkerConfig()).toThrow(/must be configured together/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires the Canvas tool endpoint and signing secret as one configuration unit", () => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_CANVAS_TOOL_URL", "https://workbench.test/api/v1/runtime/canvas/tools/execute");
    expect(() => loadWorkerConfig()).toThrow(/must be configured together/);
  });

  it.each([
    [
      "https://other.test/api/v1/runtime/canvas/visuals",
      "a different origin",
    ],
    [
      "https://workbench.test/api/v1/runtime/canvas/images",
      "a non-canonical path",
    ],
  ])("rejects the Canvas visual endpoint on %s (%s)", (visualEndpoint) => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID", "runtime-access");
    vi.stubEnv("WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY", "runtime-secret");
    vi.stubEnv("WORKBENCH_CANVAS_TOOL_URL", "https://workbench.test/api/v1/runtime/canvas/tools/execute");
    vi.stubEnv("WORKBENCH_CANVAS_VISUAL_URL", visualEndpoint);
    vi.stubEnv("WORKBENCH_CANVAS_TOOL_SECRET", Buffer.alloc(32, 8).toString("base64url"));

    expect(() => loadWorkerConfig()).toThrow(/share one origin and use their canonical capability paths/u);
  });

  it.each([
    "https://workbench.test/api/v1/runtime/knowledge/retrieve?token=secret",
    "https://workbench.test/api/v1/runtime/knowledge/retrieve#fragment",
  ])("rejects an unsafe Knowledge tool endpoint: %s", (endpoint) => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_URL", endpoint);
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_SECRET", Buffer.alloc(32, 7).toString("base64url"));
    try {
      expect(() => loadWorkerConfig()).toThrow(/safe HTTP\(S\) URL/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a plaintext Knowledge tool endpoint in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://localhost/workbench?schema=workbench");
    vi.stubEnv("DEERFLOW_LANGGRAPH_URL", "https://deerflow.test/api/");
    vi.stubEnv("DEERFLOW_GATEWAY_URL", "https://deerflow.test/");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_URL", "http://workbench.test/api/v1/runtime/knowledge/retrieve");
    vi.stubEnv("WORKBENCH_KNOWLEDGE_TOOL_SECRET", Buffer.alloc(32, 7).toString("base64url"));
    try {
      expect(() => loadWorkerConfig()).toThrow(/production capability endpoints require HTTPS/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
