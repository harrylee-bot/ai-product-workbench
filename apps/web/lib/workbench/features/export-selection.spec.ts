import { describe, expect, it } from "vitest";
import { alignArtifactSelectionWithPins, rebaseSavedPrdSelection } from "./export-selection";

describe("saved PRD publication selections", () => {
  const selection = { kind: "artifact", artifactId: "prd-1", artifactVersionId: "v1" } as const;
  it("uses the persisted replacement version and leaves other artifacts alone", () => {
    const replacements = [{ projectId: "project-1", artifactId: "prd-1", artifactVersionId: "v1", savedArtifactVersionId: "v2" }];
    expect(rebaseSavedPrdSelection(selection, replacements)).toEqual({ ...selection, artifactVersionId: "v2" });
    expect(rebaseSavedPrdSelection({ ...selection, artifactId: "prd-2" }, replacements)).toEqual({ ...selection, artifactId: "prd-2" });
  });
  it("corrects a selection captured before a concurrent save and rejects ambiguous pins", () => {
    expect(alignArtifactSelectionWithPins(selection, [{ artifactId: "prd-1", artifactVersionId: "v2" }]))
      .toEqual({ ...selection, artifactVersionId: "v2" });
    expect(() => alignArtifactSelectionWithPins(selection, [
      { artifactId: "prd-1", artifactVersionId: "v2" }, { artifactId: "prd-1", artifactVersionId: "v3" },
    ])).toThrow("选区已变化");
  });
});
