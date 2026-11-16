import { describe, expect, it } from "vitest";
import {
  artifactLinksQuerySchema,
  createArtifactLinkRequestSchema,
  createImageArtifactRequestSchema,
} from "../src/artifacts.js";
describe("Fixed artifact link contracts", () => {
  const source = { artifactId: "a", artifactVersionId: "a1" },
    target = { artifactId: "b", artifactVersionId: "b1" };
  it("requires explicit distinct endpoints, bounded human labels and known manual relation types", () => {
    expect(
      createArtifactLinkRequestSchema.parse({
        source,
        target,
        kind: "derived",
        label: "  来源  ",
      }).label,
    ).toBe("来源");
    for (const input of [
      { source, target: source, kind: "related" },
      { source, target: { artifactId: "b" }, kind: "reference" },
      { source, target, kind: "bezier" },
      { source, target, kind: "related", label: "x".repeat(241) },
    ])
      expect(() => createArtifactLinkRequestSchema.parse(input)).toThrow();
    expect(artifactLinksQuerySchema.parse({ limit: "30" })).toEqual({
      limit: 30,
      includeRemoved: "false",
    });
    expect(() => artifactLinksQuerySchema.parse({ limit: 101 })).toThrow();
  });
  it("keeps old image command hashes stable and preserves optional exact save-as origin", () => {
    const original = {
      kind: "image",
      title: "Image",
      source: { kind: "file", fileAssetId: "file" },
    };
    expect(createImageArtifactRequestSchema.parse(original)).toEqual(original);
    expect(
      createImageArtifactRequestSchema.parse({
        ...original,
        derivedFrom: source,
      }).derivedFrom,
    ).toEqual(source);
    expect(() =>
      createImageArtifactRequestSchema.parse({
        ...original,
        derivedFrom: { artifactId: "a" },
      }),
    ).toThrow();
  });
});
