import { describe, expect, it } from "vitest";
import {
  figmaExportDocumentSchema,
  workbenchFigmaImporterVersion,
} from "../src/index.js";

const sha256 = "a".repeat(64);
const literal = (value: number) => ({ kind: "literal" as const, value });

function prototypeDocument(withImage = false) {
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-document",
    title: "Checkout",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "root-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: "root-home",
      screenId: "screen-home",
      parentId: null,
      name: "Home",
      visible: true,
      layout: {
        mode: "absolute" as const,
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "block" as const,
        direction: "column" as const,
        gap: literal(0),
        padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
        align: "stretch" as const,
        justify: "start" as const,
        gridColumns: null,
        overflow: "hidden" as const,
      },
      style: {
        opacity: 1,
        rotation: 0,
        transformOrigin: { x: 0.5, y: 0.5 },
        fill: { kind: "literal" as const, value: "#ffffff" },
        stroke: null,
        radii: {
          topLeft: literal(0),
          topRight: literal(0),
          bottomRight: literal(0),
          bottomLeft: literal(0),
        },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame" as const,
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: withImage ? [{
      id: "hero-image",
      kind: "image" as const,
      name: "Hero",
      blobId: "blob-hero",
      mediaType: "image/png" as const,
      byteSize: 12,
      sha256,
      width: 1,
      height: 1,
    }] : [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function exportDocument(withImage = false) {
  return {
    protocol: "workbench.figma-export.v1" as const,
    schemaVersion: 1 as const,
    importer: {
      minimumVersion: workbenchFigmaImporterVersion,
      pluginName: "产品工作台 Importer" as const,
    },
    release: { id: "release-1", projectId: "project-1", version: 1 },
    selection: { kind: "release" as const },
    prototypes: [{
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      title: "Checkout",
      version: 1,
      checksum: "b".repeat(64),
      selectedScreenIds: ["screen-home"],
      document: prototypeDocument(withImage),
    }],
    assets: withImage ? [{
      artifactVersionId: "version-1",
      assetId: "hero-image",
      kind: "image" as const,
      mediaType: "image/png" as const,
      byteSize: 12,
      sha256,
      archivePath: `assets/${sha256}.png`,
    }] : [],
  };
}

describe("workbench.figma-export.v1", () => {
  it("pins the release, importer version, selected screens and asset identities", () => {
    expect(figmaExportDocumentSchema.parse(exportDocument(true))).toEqual(exportDocument(true));
  });

  it("rejects unknown selected screens and importer protocol drift", () => {
    const screenDrift = exportDocument();
    screenDrift.prototypes[0]!.selectedScreenIds = ["screen-missing"];
    expect(figmaExportDocumentSchema.safeParse(screenDrift).success).toBe(false);

    const importerDrift = {
      ...exportDocument(),
      importer: { minimumVersion: "2.0.0", pluginName: "产品工作台 Importer" },
    };
    expect(figmaExportDocumentSchema.safeParse(importerDrift).success).toBe(false);
  });

  it("rejects missing, changed and non-content-addressed binary assets", () => {
    const missing = exportDocument(true);
    missing.assets = [];
    expect(figmaExportDocumentSchema.safeParse(missing).success).toBe(false);

    const changed = exportDocument(true);
    changed.assets[0]!.byteSize = 11;
    expect(figmaExportDocumentSchema.safeParse(changed).success).toBe(false);

    const wrongPath = exportDocument(true);
    wrongPath.assets[0]!.archivePath = `assets/${"c".repeat(64)}.png`;
    expect(figmaExportDocumentSchema.safeParse(wrongPath).success).toBe(false);
  });
});
