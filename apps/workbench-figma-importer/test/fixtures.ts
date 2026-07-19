import { type PrototypeDocument, prototypeDocumentSchema } from "@workbench/workbench-contracts/prototype";
import { figmaExportDocumentSchema, type FigmaExportDocument } from "@workbench/workbench-contracts/figma-export";

const literal = (value: number) => ({ kind: "literal" as const, value });
const color = (value: string) => ({ kind: "literal" as const, value });

export function prototypeFixture(): PrototypeDocument {
  const layout = (x: number, y: number, width: number, height: number) => ({
    mode: "absolute" as const,
    x: literal(x),
    y: literal(y),
    width: literal(width),
    height: literal(height),
    display: "block" as const,
    direction: "column" as const,
    gap: literal(0),
    padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
    align: "start" as const,
    justify: "start" as const,
    gridColumns: null,
    overflow: "visible" as const,
  });
  const style = (fill: string | null = "#ffffff") => ({
    opacity: 1,
    rotation: 12,
    transformOrigin: { x: 0.25, y: 0.75 },
    fill: fill ? color(fill) : null,
    stroke: null,
    radii: { topLeft: literal(4), topRight: literal(4), bottomRight: literal(4), bottomLeft: literal(4) },
    shadowTokenIds: [],
    typography: null,
  });
  const textStyle = {
    ...style("#111111"),
    typography: {
      fontFamily: { kind: "literal" as const, value: "Inter" },
      fontSize: literal(16),
      fontWeight: { kind: "literal" as const, value: 400 as const },
      lineHeight: literal(24),
      letterSpacing: literal(0),
      align: "left" as const,
      transform: "none" as const,
      decoration: "none" as const,
    },
  };
  return prototypeDocumentSchema.parse({
    protocol: "workbench.prototype.v1",
    documentId: "document-1",
    title: "Importer fixture",
    revision: 1,
    screens: [{
      id: "screen-1",
      name: "Home",
      route: "/",
      rootNodeId: "root-1",
      initialStateId: null,
      viewport: { width: 640, height: 480 },
    }],
    nodes: [
      {
        id: "root-1",
        screenId: "screen-1",
        parentId: null,
        name: "Home root",
        visible: true,
        layout: layout(0, 0, 640, 480),
        style: style(),
        actionIds: [],
        bindingIds: [],
        motionIds: [],
        kind: "frame",
        childIds: ["title-1", "button-1"],
        clipContent: true,
      },
      {
        id: "title-1",
        screenId: "screen-1",
        parentId: "root-1",
        name: "Title",
        visible: true,
        layout: layout(24, 24, 240, 40),
        style: textStyle,
        actionIds: [],
        bindingIds: [],
        motionIds: [],
        kind: "text",
        text: "产品工作台",
        maxLines: null,
      },
      {
        id: "button-1",
        screenId: "screen-1",
        parentId: "root-1",
        name: "Continue",
        visible: true,
        layout: layout(24, 96, 160, 48),
        style: style("#3366ff"),
        actionIds: [],
        bindingIds: [],
        motionIds: [],
        kind: "button",
        label: "继续",
        childIds: [],
        buttonType: "button",
        disabled: false,
      },
    ],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  });
}

export function exportFixture(): FigmaExportDocument {
  const document = prototypeFixture();
  return figmaExportDocumentSchema.parse({
    protocol: "workbench.figma-export.v1",
    schemaVersion: 1,
    importer: { minimumVersion: "1.0.0", pluginName: "产品工作台 Importer" },
    release: { id: "release-1", projectId: "project-1", version: 1 },
    selection: { kind: "artifact", artifactId: "artifact-1", artifactVersionId: "version-1" },
    prototypes: [{
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      title: "Importer fixture",
      version: 1,
      checksum: "a".repeat(64),
      selectedScreenIds: ["screen-1"],
      document,
    }],
    assets: [],
  });
}
