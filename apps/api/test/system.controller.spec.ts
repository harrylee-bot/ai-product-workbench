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
  });
});
