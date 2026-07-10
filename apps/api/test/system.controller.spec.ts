import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemController } from "../src/modules/system/system.controller";

describe("SystemController", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the real workbench API, conversation module, and DeerFlow enabled flag", () => {
    vi.stubEnv("DEERFLOW_ENABLED", "true");
    vi.stubEnv("DEERFLOW_MODEL_NAME", "workbench-claude");
    vi.stubEnv("APP_BUILD_SHA", "abc123def456");
    const result = new SystemController().health();

    expect(result).toMatchObject({
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
      build: { commitSha: "abc123def456" },
      deerflow: {
        enabled: true,
        modelId: "deerflow/workbench-claude",
        modelName: "workbench-claude",
        modelDisplayName: "workbench-claude",
        runtimeName: "lead_agent",
        models: [
          expect.objectContaining({
            id: "deerflow/workbench-claude",
            name: "workbench-claude",
          }),
        ],
      },
    });
    expect(result.modules).toContain("conversations");
    expect(result.modules).toContain("requirement-documents");
    expect(result.modules).toContain("prototype-artifacts");
    expect(result.modules).toContain("knowledge-base");
    expect(result.modules).toContain("admin-dashboard");
    expect(result.modules).toContain("admin-audit");
  });

  it("reports DeerFlow disabled when the runtime switch is not true", () => {
    vi.stubEnv("DEERFLOW_ENABLED", "false");

    expect(new SystemController().health().deerflow.enabled).toBe(false);
  });

  it("uses an explicit unknown build marker outside a versioned deployment", () => {
    expect(new SystemController().health().build).toEqual({ commitSha: "unknown" });
  });

  it("returns runtime model choices from stage model environment variables", () => {
    vi.stubEnv("DEERFLOW_ENABLED", "true");
    vi.stubEnv("DEFAULT_MODEL_PROVIDER_NAME", "datatoken");
    vi.stubEnv("DEFAULT_MODEL_NAME", "gpt-default");
    vi.stubEnv("DEFAULT_MODEL_FAST_NAME", "gpt-fast");
    vi.stubEnv("DEFAULT_MODEL_REASONING_NAME", "gpt-reasoning");
    vi.stubEnv("DEFAULT_MODEL_TASK_QA_CHECK_NAME", "gpt-qa");

    const result = new SystemController().health();

    expect(result.deerflow.modelId).toBe("datatoken/gpt-default");
    expect(result.deerflow.models).toEqual([
      expect.objectContaining({ id: "datatoken/gpt-default", name: "gpt-default" }),
      expect.objectContaining({ id: "datatoken/gpt-fast", name: "快速响应 · gpt-fast" }),
      expect.objectContaining({ id: "datatoken/gpt-reasoning", name: "推理规划 · gpt-reasoning" }),
      expect.objectContaining({ id: "datatoken/gpt-qa", name: "质量检查 · gpt-qa" }),
    ]);
  });
});
