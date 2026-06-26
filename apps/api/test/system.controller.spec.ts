import { describe, expect, it } from "vitest";
import { SystemController } from "../src/modules/system/system.controller";

describe("SystemController", () => {
  it("reports the real workbench API and project module", () => {
    const result = new SystemController().health();

    expect(result).toMatchObject({
      ok: true,
      service: "ai-product-workbench-api",
    });
    expect(result.modules).toContain("projects");
    expect(result.modules).toContain("runtime-orchestrator");
    expect(result.modules).toContain("runtime-adapters");
    expect(result.modules).toContain("codex-runtime-adapter");
    expect(result.modules).toContain("deerflow-runtime-adapter");
    expect(result.modules).toContain("product-runtime-service");
    expect(result.modules).toContain("requirement-documents");
    expect(result.modules).toContain("prototype-artifacts");
    expect(result.modules).toContain("patch-preview");
    expect(result.modules).toContain("knowledge-base");
    expect(result.modules).toContain("admin-dashboard");
    expect(result.modules).toContain("admin-audit");
  });
});
