import { describe, expect, it } from "vitest";
import { SystemController } from "../src/system/system.controller";

describe("SystemController", () => {
  it("reports the real workbench API and project module", () => {
    const result = new SystemController().health();

    expect(result).toMatchObject({
      ok: true,
      service: "ai-product-workbench-api",
    });
    expect(result.modules).toContain("projects");
    expect(result.modules).toContain("requirement-documents");
    expect(result.modules).toContain("prototype-artifacts");
    expect(result.modules).toContain("patch-records");
    expect(result.modules).toContain("knowledge-base");
    expect(result.modules).toContain("admin-dashboard");
    expect(result.modules).toContain("admin-logs");
    expect(result.modules).toContain("admin-audit");
  });
});
