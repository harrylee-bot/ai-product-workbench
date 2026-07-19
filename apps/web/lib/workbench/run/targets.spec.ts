import { describe, expect, it } from "vitest";

import {
  isValidEditArtifactTargets,
  toRunArtifactTargets,
} from "./targets";

describe("toRunArtifactTargets", () => {
  it("groups multiple selected screens from one immutable ArtifactVersion", () => {
    expect(toRunArtifactTargets([
      { artifactId: "artifact-a", artifactVersionId: "version-a", screenId: "screen-home" },
      { artifactId: "artifact-a", artifactVersionId: "version-a", screenId: "screen-success" },
      { artifactId: "artifact-a", artifactVersionId: "version-a", screenId: "screen-home" },
    ])).toEqual([{
      artifactId: "artifact-a",
      artifactVersionId: "version-a",
      screenIds: ["screen-home", "screen-success"],
    }]);
  });

  it("lets a whole-version selection supersede screen selections", () => {
    expect(toRunArtifactTargets([
      { artifactId: "artifact-a", artifactVersionId: "version-a", screenId: "screen-home" },
      { artifactId: "artifact-a", artifactVersionId: "version-a" },
      { artifactId: "artifact-a", artifactVersionId: "version-a", screenId: "screen-success" },
    ])).toEqual([{
      artifactId: "artifact-a",
      artifactVersionId: "version-a",
      screenIds: [],
    }]);
  });

  it("rejects an impossible Artifact identity collision", () => {
    expect(() => toRunArtifactTargets([
      { artifactId: "artifact-a", artifactVersionId: "version-shared", screenId: "screen-home" },
      { artifactId: "artifact-b", artifactVersionId: "version-shared", screenId: "screen-home" },
    ])).toThrow("cannot belong to multiple Artifacts");
  });

  it("accepts only non-empty target sets allowed by the Run contract", () => {
    expect(isValidEditArtifactTargets([])).toBe(false);
    expect(isValidEditArtifactTargets([{
      artifactId: "artifact-a",
      artifactVersionId: "version-a",
      screenIds: ["screen-home"],
    }])).toBe(true);
    expect(isValidEditArtifactTargets([
      { artifactId: "artifact-a", artifactVersionId: "version-a", screenIds: [] },
      { artifactId: "artifact-a", artifactVersionId: "version-b", screenIds: [] },
    ])).toBe(false);
    expect(isValidEditArtifactTargets([{
      artifactId: "artifact-a",
      artifactVersionId: "version-a",
      screenIds: Array.from({ length: 13 }, (_, index) => `screen-${index}`),
    }])).toBe(false);
  });
});
