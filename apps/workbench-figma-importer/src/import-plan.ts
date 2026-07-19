import {
  type FigmaExportDocument,
  type FigmaExportPrototype,
  figmaExportDocumentSchema,
} from "@workbench/workbench-contracts/figma-export";
import {
  type PrototypeAsset,
  type PrototypeDocument,
  type PrototypeNode,
  type PrototypeScreen,
  type PrototypeStyle,
  type PrototypeToken,
} from "@workbench/workbench-contracts/prototype";

import { figmaImportAssetKey, type FigmaImportAssetBytes } from "./types";

export type ResolvedPrototypeLayout = Omit<PrototypeLayout, "x" | "y" | "width" | "height" | "gap" | "padding"> & {
  x: number;
  y: number;
  width: number;
  height: number;
  gap: number;
  padding: { top: number; right: number; bottom: number; left: number };
};

type PrototypeLayout = PrototypeNode["layout"];

export type ResolvedPrototypeStyle = Omit<PrototypeStyle, "fill" | "stroke" | "radii" | "typography"> & {
  fill: string | null;
  stroke: {
    color: string;
    width: number;
    style: "solid" | "dashed" | "dotted";
    position: "inside" | "center" | "outside";
  } | null;
  radii: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  typography: {
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    letterSpacing: number;
    align: "left" | "center" | "right" | "justify";
    transform: "none" | "uppercase" | "lowercase" | "capitalize";
    decoration: "none" | "underline" | "lineThrough";
  } | null;
};

export type FigmaImportPlanNode = {
  source: PrototypeNode;
  layout: ResolvedPrototypeLayout;
  style: ResolvedPrototypeStyle;
  children: FigmaImportPlanNode[];
  generatedLabel: string | null;
};

export type FigmaImportPlanScreen = {
  source: PrototypeScreen;
  root: FigmaImportPlanNode;
};

export type FigmaImportPlanPrototype = {
  source: FigmaExportPrototype;
  screens: FigmaImportPlanScreen[];
  assets: Map<string, PrototypeAsset>;
  tokens: Map<string, PrototypeToken>;
};

export type FigmaImportPlan = {
  document: FigmaExportDocument;
  assets: FigmaImportAssetBytes;
  prototypes: FigmaImportPlanPrototype[];
};

export class FigmaImportPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaImportPlanError";
  }
}

export function buildFigmaImportPlan(
  document: FigmaExportDocument,
  assets: FigmaImportAssetBytes,
): FigmaImportPlan {
  const parsed = figmaExportDocumentSchema.parse(document);
  const prototypes = parsed.prototypes.map((prototype) => buildPrototypePlan(prototype, assets));
  return { document: parsed, assets, prototypes };
}

function buildPrototypePlan(
  prototype: FigmaExportPrototype,
  archiveAssets: FigmaImportAssetBytes,
): FigmaImportPlanPrototype {
  const document = prototype.document;
  const tokens = new Map(document.tokens.map((token) => [token.id, token]));
  const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
  const screens = new Map(document.screens.map((screen) => [screen.id, screen]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const selectedScreens = prototype.selectedScreenIds.map((screenId) => {
    const screen = screens.get(screenId);
    if (!screen) throw new FigmaImportPlanError(`Selected screen ${screenId} does not exist`);
    return screen;
  });
  const planScreens = selectedScreens.map((screen) => {
    const root = nodes.get(screen.rootNodeId);
    if (!root) throw new FigmaImportPlanError(`Screen ${screen.id} has no root node`);
    return {
      source: screen,
      root: buildNodePlan(root, nodes, assets, tokens, archiveAssets, prototype.artifactVersionId, new Set()),
    };
  });
  return { source: prototype, screens: planScreens, assets, tokens };
}

function buildNodePlan(
  source: PrototypeNode,
  nodes: Map<string, PrototypeNode>,
  assets: Map<string, PrototypeAsset>,
  tokens: Map<string, PrototypeToken>,
  archiveAssets: FigmaImportAssetBytes,
  artifactVersionId: string,
  path: Set<string>,
): FigmaImportPlanNode {
  if (path.has(source.id)) throw new FigmaImportPlanError(`Prototype node cycle detected at ${source.id}`);
  const nextPath = new Set(path).add(source.id);
  const children = childIds(source).map((childId) => {
    const child = nodes.get(childId);
    if (!child) throw new FigmaImportPlanError(`Node ${source.id} references missing child ${childId}`);
    return buildNodePlan(child, nodes, assets, tokens, archiveAssets, artifactVersionId, nextPath);
  });

  if (source.kind === "image") {
    const asset = assets.get(source.assetId);
    if (!asset || asset.kind !== "image" || !archiveAssets[figmaImportAssetKey(artifactVersionId, asset.id)]) {
      throw new FigmaImportPlanError(`Image node ${source.id} has no verified image asset`);
    }
  }
  if (source.kind === "icon") {
    const asset = assets.get(source.assetId);
    if (!asset || asset.kind !== "icon") throw new FigmaImportPlanError(`Icon node ${source.id} has no icon asset`);
  }

  return {
    source,
    layout: resolveLayout(source.layout, tokens),
    style: resolveStyle(source.style, tokens),
    children,
    generatedLabel: generatedLabel(source),
  };
}

function childIds(node: PrototypeNode): string[] {
  return node.kind === "frame" || node.kind === "form" || node.kind === "button"
    ? node.childIds
    : [];
}

function resolveLayout(layout: PrototypeLayout, tokens: Map<string, PrototypeToken>): ResolvedPrototypeLayout {
  return {
    ...layout,
    x: resolveNumber(layout.x, tokens, "layout.x"),
    y: resolveNumber(layout.y, tokens, "layout.y"),
    width: resolveNumber(layout.width, tokens, "layout.width"),
    height: resolveNumber(layout.height, tokens, "layout.height"),
    gap: resolveNumber(layout.gap, tokens, "layout.gap"),
    padding: {
      top: resolveNumber(layout.padding.top, tokens, "layout.padding.top"),
      right: resolveNumber(layout.padding.right, tokens, "layout.padding.right"),
      bottom: resolveNumber(layout.padding.bottom, tokens, "layout.padding.bottom"),
      left: resolveNumber(layout.padding.left, tokens, "layout.padding.left"),
    },
  };
}

function resolveStyle(style: PrototypeStyle, tokens: Map<string, PrototypeToken>): ResolvedPrototypeStyle {
  const typography = style.typography
    ? {
        fontFamily: resolveString(style.typography.fontFamily, tokens, "typography.fontFamily"),
        fontSize: resolveNumber(style.typography.fontSize, tokens, "typography.fontSize"),
        fontWeight: resolveFontWeight(style.typography.fontWeight, tokens),
        lineHeight: resolveNumber(style.typography.lineHeight, tokens, "typography.lineHeight"),
        letterSpacing: resolveNumber(style.typography.letterSpacing, tokens, "typography.letterSpacing"),
        align: style.typography.align,
        transform: style.typography.transform,
        decoration: style.typography.decoration,
      }
    : null;
  return {
    ...style,
    fill: style.fill ? resolveColor(style.fill, tokens, "style.fill") : null,
    stroke: style.stroke
      ? {
          ...style.stroke,
          color: resolveColor(style.stroke.color, tokens, "style.stroke.color"),
          width: resolveNumber(style.stroke.width, tokens, "style.stroke.width"),
        }
      : null,
    radii: {
      topLeft: resolveNumber(style.radii.topLeft, tokens, "style.radii.topLeft"),
      topRight: resolveNumber(style.radii.topRight, tokens, "style.radii.topRight"),
      bottomRight: resolveNumber(style.radii.bottomRight, tokens, "style.radii.bottomRight"),
      bottomLeft: resolveNumber(style.radii.bottomLeft, tokens, "style.radii.bottomLeft"),
    },
    typography,
    shadowTokenIds: [...style.shadowTokenIds],
  };
}

function resolveNumber(
  value: { kind: "literal"; value: number } | { kind: "token"; tokenId: string },
  tokens: Map<string, PrototypeToken>,
  path: string,
): number {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || !["number", "spacing", "radius", "fontSize", "lineHeight", "borderWidth", "duration"].includes(token.type)) {
    throw new FigmaImportPlanError(`Token ${value.tokenId} at ${path} is not numeric`);
  }
  if (token.type === "shadow" || token.type === "color" || token.type === "fontFamily") {
    throw new FigmaImportPlanError(`Token ${value.tokenId} at ${path} is not numeric`);
  }
  return token.value;
}

function resolveColor(
  value: { kind: "literal"; value: string } | { kind: "token"; tokenId: string },
  tokens: Map<string, PrototypeToken>,
  path: string,
): string {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || token.type !== "color") throw new FigmaImportPlanError(`Token ${value.tokenId} at ${path} is not a color`);
  return token.value;
}

function resolveString(
  value: { kind: "literal"; value: string } | { kind: "token"; tokenId: string },
  tokens: Map<string, PrototypeToken>,
  path: string,
): string {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || token.type !== "fontFamily") throw new FigmaImportPlanError(`Token ${value.tokenId} at ${path} is not a font family`);
  return token.value;
}

function resolveFontWeight(
  value: { kind: "literal"; value: number } | { kind: "token"; tokenId: string },
  tokens: Map<string, PrototypeToken>,
): number {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || token.type !== "fontWeight") throw new FigmaImportPlanError(`Token ${value.tokenId} is not a font weight`);
  return token.value;
}

function generatedLabel(node: PrototypeNode): string | null {
  if (node.kind === "button") return node.label;
  if (node.kind === "input") return node.label;
  return null;
}

export function prototypeDocumentForPlan(plan: FigmaImportPlanPrototype): PrototypeDocument {
  return plan.source.document;
}
