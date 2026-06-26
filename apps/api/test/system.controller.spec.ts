import { describe, expect, it } from "vitest";
import { SystemController } from "../src/modules/system/system.controller";

describe("SystemController", () => {
  it("reports the real workbench API and project module", () => {
    const result = new SystemController().health();

    expect(result).toMatchObject({
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
    });
    expect(result.modules).toContain("projects");
    expect(result.modules).not.toContain("runtime-adapters");
    expect(result.modules).not.toContain("codex-runtime-adapter");
    expect(result.modules).not.toContain("deerflow-runtime-adapter");
    expect(result.modules).not.toContain("product-runtime-service");
    expect(result.modules).toContain("requirement-documents");
    expect(result.modules).toContain("prototype-artifacts");
    expect(result.modules).toContain("patch-preview");
    expect(result.modules).toContain("knowledge-base");
    expect(result.modules).toContain("admin-dashboard");
    expect(result.modules).toContain("admin-audit");
  });
});
