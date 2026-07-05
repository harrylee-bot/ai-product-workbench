import { describe, expect, it } from "vitest";
import { SystemController } from "../src/modules/system/system.controller";

describe("SystemController", () => {
  it("reports the real workbench API, conversation module, and DeerFlow enabled flag", () => {
    process.env.DEERFLOW_ENABLED = "true";
    process.env.DEERFLOW_MODEL_NAME = "workbench-claude";
    const result = new SystemController().health();

    expect(result).toMatchObject({
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
      deerflow: {
        enabled: true,
        modelId: "deerflow/workbench-claude",
        modelName: "workbench-claude",
        modelDisplayName: "workbench-claude",
        runtimeName: "lead_agent",
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
    process.env.DEERFLOW_ENABLED = "false";

    expect(new SystemController().health().deerflow.enabled).toBe(false);
  });
});
