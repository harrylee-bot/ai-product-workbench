import { describe, expect, it } from "vitest";

import {
  assertRunnableArtifactRequest,
  WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE,
} from "./artifact-intent";

describe("assertRunnableArtifactRequest", () => {
  it("accepts linked PRD and Prototype, but rejects PRD with unsupported output kinds", () => {
    expect(() => assertRunnableArtifactRequest(["prd", "prototype"]))
      .not.toThrow();
    expect(() => assertRunnableArtifactRequest(["code", "prd"]))
      .toThrow(WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE);
    expect(() => assertRunnableArtifactRequest(["prd"]))
      .not.toThrow();
    expect(() => assertRunnableArtifactRequest(["prototype"]))
      .not.toThrow();
  });
});
