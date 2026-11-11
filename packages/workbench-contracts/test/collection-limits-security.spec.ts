import { describe, expect, it } from "vitest";
import { runSourceIdsSchema } from "../src/import-sources.js";
import { runArtifactTargetsSchema } from "../src/runs.js";
import { runtimeResultSchema } from "../src/runtime.js";

function oversizedCollection(length: number) {
  const values = new Array(length);
  Object.defineProperty(values, 0, {
    get() { throw new Error("oversized input must be rejected before walking elements"); },
  });
  return values;
}

describe("untrusted collection resource limits", () => {
  it("rejects oversized Run source ids before parsing or checking uniqueness", () => {
    const result = runSourceIdsSchema.safeParse(oversizedCollection(100_000));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: "too_big", maximum: 50 }]);
  });

  it("rejects oversized Artifact selections before traversing target objects", () => {
    const result = runArtifactTargetsSchema.safeParse(oversizedCollection(100_000));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: "too_big", maximum: 12 }]);
  });

  it("rejects oversized Runtime output before parsing nested artifact graphs", () => {
    const result = runtimeResultSchema.safeParse({
      protocol: "workbench.runtime.result.v1",
      message: "",
      artifacts: oversizedCollection(100_000),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([
      { code: "too_big", maximum: 20, path: ["artifacts"] },
    ]);
  });
});
