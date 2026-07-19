import {
  createDesignSystemRequestSchema,
  designSystemCatalogSchema,
  designSystemDocumentSchema,
  materializeRuntimeDesignStyleSnapshot,
  publicDesignSystemDocumentSchema,
  startRunRequestSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const sha256 = "a".repeat(64);

function documentFixture() {
  return {
    protocol: "workbench.design-system.v1" as const,
    documentId: "design-system-main",
    title: "Workbench UI",
    tokens: [
      {
        id: "token-color-primary",
        path: "color.primary",
        type: "color" as const,
        value: { kind: "literal" as const, value: "#2563eb" },
        description: "Primary action color",
      },
      {
        id: "token-color-link",
        path: "color.link",
        type: "color" as const,
        value: { kind: "alias" as const, path: "color.primary" },
        description: null,
      },
    ],
    assets: [{
      id: "asset-logo",
      kind: "image" as const,
      name: "Product logo",
      blobId: "blob_logo",
      mediaType: "image/png",
      byteSize: 128,
      sha256,
      width: 64,
      height: 64,
    }],
    principles: [{
      id: "principle-clarity",
      title: "Clarity",
      description: "Prefer direct hierarchy and visible state.",
    }],
    guidelines: [{
      id: "guideline-actions",
      title: "Actions",
      description: "Use the primary color for the main command.",
      principleIds: ["principle-clarity"],
      tokenPaths: ["color.primary"],
      componentIds: ["component-button"],
    }],
    components: [{
      id: "component-button",
      name: "Button",
      description: "Command control",
      usage: {
        summary: "Use for explicit commands.",
        do: ["Use one primary action per surface."],
        dont: ["Do not use for passive status."],
      },
      tokenPaths: ["color.primary"],
      assetIds: ["asset-logo"],
      variants: [{
        id: "variant-button-primary",
        name: "Primary",
        description: null,
        tokenPaths: ["color.primary"],
        assetIds: [],
      }],
      states: [{
        id: "state-button-disabled",
        name: "Disabled",
        description: null,
        tokenPaths: ["color.link"],
        assetIds: [],
      }],
    }],
  };
}

describe("workbench.design-system.v1", () => {
  it("resolves aliases and materializes only pinned internal runtime facts", () => {
    const document = designSystemDocumentSchema.parse(documentFixture());
    const snapshot = materializeRuntimeDesignStyleSnapshot({
      projectId: "project_target",
      artifactId: "artifact_design",
      artifactVersionId: "version_design",
      checksum: "b".repeat(64),
      document,
      assetPins: [{
        assetId: "asset-logo",
        kind: "image",
        blobId: "blob_logo",
        mediaType: "image/png",
        byteSize: 128n,
        sha256,
      }],
    });

    expect(snapshot.tokens.map(({ path, value }) => ({ path, value }))).toEqual([
      { path: "color.primary", value: "#2563eb" },
      { path: "color.link", value: "#2563eb" },
    ]);
    expect(snapshot.assets[0]).toMatchObject({
      id: "asset-logo",
      artifactVersionId: "version_design",
      blobId: "blob_logo",
      sha256,
    });
    expect(JSON.stringify(snapshot)).not.toContain("styleDictionary");
  });

  it("rejects alias cycles, dangling references, and type-changing aliases", () => {
    const cycle = documentFixture();
    cycle.tokens[0]!.value = { kind: "alias", path: "color.link" };
    expect(designSystemDocumentSchema.safeParse(cycle).success).toBe(false);

    const dangling = documentFixture();
    dangling.components[0]!.tokenPaths = ["color.missing"];
    expect(designSystemDocumentSchema.safeParse(dangling).success).toBe(false);

    const wrongType = documentFixture();
    wrongType.tokens.push({
      id: "token-space",
      path: "space.small",
      type: "dimension",
      value: { kind: "alias", path: "color.primary" },
      description: null,
    });
    expect(designSystemDocumentSchema.safeParse(wrongType).success).toBe(false);
  });

  it("enforces globally unique component, variant, and state ids", () => {
    const duplicate = documentFixture();
    duplicate.components[0]!.states[0]!.id = duplicate.components[0]!.variants[0]!.id;
    expect(designSystemDocumentSchema.safeParse(duplicate).success).toBe(false);
  });

  it("keeps the public projection semantically equivalent without Blob ids", () => {
    const source = documentFixture();
    const publicDocument = {
      ...source,
      assets: source.assets.map(({ blobId: _blobId, ...asset }) => asset),
    };
    expect(publicDesignSystemDocumentSchema.safeParse(publicDocument).success).toBe(true);

    const invalid = structuredClone(publicDocument);
    invalid.guidelines[0]!.componentIds = ["component-missing"];
    expect(publicDesignSystemDocumentSchema.safeParse(invalid).success).toBe(false);
  });

  it("provides a typed creation command but forbids Runtime generation of design systems", () => {
    expect(createDesignSystemRequestSchema.safeParse({
      title: "Workbench UI",
      document: documentFixture(),
    }).success).toBe(true);
    expect(startRunRequestSchema.safeParse({
      prompt: "Generate a design system",
      modelId: "quality",
      workflow: "generate",
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      requestedArtifactKinds: ["design_system"],
    }).success).toBe(false);
  });

  it("exposes only immutable ready-version metadata through the Workspace catalog", () => {
    expect(designSystemCatalogSchema.parse({
      items: [{
        projectId: "project_source",
        projectTitle: "Source Project",
        artifactId: "artifact_design",
        artifactTitle: "Workbench UI",
        artifactVersionId: "version_design",
        version: 3,
        checksum: sha256,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T01:00:00.000Z",
      }],
      nextCursor: null,
    }).items[0]).not.toHaveProperty("content");
  });

  it("requires every document asset to have an exact immutable pin", () => {
    expect(() => materializeRuntimeDesignStyleSnapshot({
      projectId: "project_target",
      artifactId: "artifact_design",
      artifactVersionId: "version_design",
      checksum: "b".repeat(64),
      document: documentFixture(),
      assetPins: [],
    })).toThrow("DESIGN_SYSTEM_ASSET_PIN_MISMATCH");
  });
});
