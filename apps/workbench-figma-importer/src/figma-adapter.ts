import type {
  PrototypeAsset,
  PrototypeNode,
} from "@workbench/workbench-contracts/prototype";

import {
  type FigmaImportPlan,
  type FigmaImportPlanNode,
  type FigmaImportPlanPrototype,
  type FigmaImportPlanScreen,
} from "./import-plan";
import { figmaImportAssetKey } from "./types";

type PrototypeFontAsset = Extract<PrototypeAsset, { kind: "font" }>;
type PrototypeIconAsset = Extract<PrototypeAsset, { kind: "icon" }>;
type PrototypeVectorNode = Extract<PrototypeNode, { kind: "vector" }>;

export const WORKBENCH_PLUGIN_DATA = {
  sourceId: "workbench.sourceId",
  kind: "workbench.kind",
  artifactId: "workbench.artifactId",
  artifactVersionId: "workbench.artifactVersionId",
  screenId: "workbench.screenId",
  actionIds: "workbench.actionIds",
  bindingIds: "workbench.bindingIds",
  motionIds: "workbench.motionIds",
  actions: "workbench.actions",
  bindings: "workbench.bindings",
  motions: "workbench.motions",
  transformOrigin: "workbench.transformOrigin",
  generatedFor: "workbench.generatedFor",
  sourceRoute: "workbench.sourceRoute",
  gridColumns: "workbench.gridColumns",
  sourceLayout: "workbench.sourceLayout",
  sourceNode: "workbench.sourceNode",
} as const;

export interface FigmaImportNode {
  name: string;
  remove(): void;
  setPluginData(key: string, value: string): void;
}

export interface FigmaImportSceneNode extends FigmaImportNode {
  x: number;
  y: number;
  visible: boolean;
  opacity: number;
  rotation: number;
  resize(width: number, height: number): void;
}

export interface FigmaImportPage extends FigmaImportNode {
  appendChild(child: FigmaImportSceneNode): void;
}

type FigmaColor = { r: number; g: number; b: number };
type FigmaPaint =
  | { type: "SOLID"; color: FigmaColor; opacity: number }
  | {
      type: "IMAGE";
      imageHash: string;
      scaleMode: "FILL" | "FIT" | "CROP" | "TILE" | "STRETCH";
      imageTransform: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
      scalingFactor: number;
      rotation: number;
      filters: Record<string, never>;
    };
type FigmaEffect = {
  type: "DROP_SHADOW";
  color: FigmaColor;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  visible: boolean;
  blendMode: "NORMAL";
};

export interface FigmaImportPaintNode extends FigmaImportSceneNode {
  fills: ReadonlyArray<FigmaPaint>;
  strokes: ReadonlyArray<FigmaPaint>;
  strokeWeight: number;
  strokeAlign: "CENTER" | "INSIDE" | "OUTSIDE";
  dashPattern: ReadonlyArray<number>;
  effects: ReadonlyArray<FigmaEffect>;
}

export interface FigmaImportCornerNode extends FigmaImportPaintNode {
  cornerRadius: number;
}

export interface FigmaImportRectangleLikeNode extends FigmaImportCornerNode {
  topLeftRadius: number;
  topRightRadius: number;
  bottomRightRadius: number;
  bottomLeftRadius: number;
}

export interface FigmaImportTextNode extends FigmaImportPaintNode {
  characters: string;
  fontName: { family: string; style: string };
  fontSize: number;
  lineHeight: { unit: "PIXELS"; value: number };
  letterSpacing: { unit: "PIXELS"; value: number };
  textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textCase: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE";
  textDecoration: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
}

export interface FigmaImportFrameNode extends FigmaImportRectangleLikeNode {
  appendChild(child: FigmaImportSceneNode): void;
  layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlignItems: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems: "MIN" | "CENTER" | "MAX" | "BASELINE";
  clipsContent: boolean;
}

export interface FigmaImportRectangleNode extends FigmaImportRectangleLikeNode {}
export interface FigmaImportVectorNode extends FigmaImportCornerNode {}

type FigmaImportShapeNode = FigmaImportRectangleNode | FigmaImportVectorNode;
type CreatedNode =
  | { kind: "text"; node: FigmaImportTextNode }
  | { kind: "frame"; node: FigmaImportFrameNode }
  | { kind: "rectangle"; node: FigmaImportRectangleNode }
  | { kind: "vector"; node: FigmaImportVectorNode };

export interface FigmaImportApi {
  createPage(): FigmaImportPage;
  createFrame(): FigmaImportFrameNode;
  createText(): FigmaImportTextNode;
  createRectangle(): FigmaImportRectangleNode;
  createImage(bytes: Uint8Array): { hash: string };
  createNodeFromSvg(svg: string): FigmaImportVectorNode;
  loadFontAsync(font: { family: string; style: string }): Promise<void>;
  setCurrentPage?(page: FigmaImportPage): void | Promise<void>;
  setSelection?(nodes: FigmaImportSceneNode[]): void;
  scrollAndZoomIntoView?(nodes: FigmaImportSceneNode[]): void;
}

export type FigmaImportProgress = {
  phase: "creating" | "finished";
  completed: number;
  total: number;
  message: string;
};

export type FigmaImportResult = {
  pageCount: number;
  screenCount: number;
  nodeCount: number;
  pages: FigmaImportPage[];
};

export async function applyFigmaImportPlan(
  plan: FigmaImportPlan,
  api: FigmaImportApi,
  onProgress: (progress: FigmaImportProgress) => void = () => undefined,
): Promise<FigmaImportResult> {
  const totalScreens = plan.prototypes.reduce((count, prototype) => count + prototype.screens.length, 0);
  const pages: FigmaImportPage[] = [];
  const createdNodes: FigmaImportNode[] = [];
  let selectedFrames: FigmaImportSceneNode[] = [];
  let completedScreens = 0;
  let nodeCount = 0;

  try {
    for (const prototype of plan.prototypes) {
      const pageFrames: FigmaImportSceneNode[] = [];
      let screenOffsetX = 0;
      const page = api.createPage();
      createdNodes.push(page);
      setMetadata(page, prototype.source, null, "page", prototype.source.title);
      page.name = `产品工作台 / ${prototype.source.title}`;
      pages.push(page);
      for (const screen of prototype.screens) {
        onProgress({
          phase: "creating",
          completed: completedScreens,
          total: totalScreens,
          message: `正在导入 ${screen.source.name}`,
        });
        const frame = await createPlanNode(plan, prototype, screen, screen.root, api, null, true, (node) => {
          createdNodes.push(node);
        });
        frame.x += screenOffsetX;
        screenOffsetX += screen.root.layout.width + 160;
        page.appendChild(frame);
        pageFrames.push(frame);
        nodeCount += countPlanNodes(screen.root);
        completedScreens += 1;
        onProgress({
          phase: "creating",
          completed: completedScreens,
          total: totalScreens,
          message: `已导入 ${screen.source.name}`,
        });
      }
      selectedFrames = pageFrames;
    }
    if (pages.at(-1)) await api.setCurrentPage?.(pages.at(-1)!);
    api.setSelection?.(selectedFrames);
    if (selectedFrames.length > 0) api.scrollAndZoomIntoView?.(selectedFrames);
    onProgress({ phase: "finished", completed: totalScreens, total: totalScreens, message: "导入完成" });
    return { pageCount: pages.length, screenCount: totalScreens, nodeCount, pages };
  } catch (error) {
    for (const node of [...createdNodes].reverse()) {
      try {
        node.remove();
      } catch {
        // Keep the original import error. Figma removes a page's descendants with it.
      }
    }
    throw error;
  }
}

async function createPlanNode(
  plan: FigmaImportPlan,
  prototype: FigmaImportPlanPrototype,
  screen: FigmaImportPlanScreen,
  planned: FigmaImportPlanNode,
  api: FigmaImportApi,
  parent: FigmaImportFrameNode | null,
  isRoot: boolean,
  onNodeCreated: (node: FigmaImportNode) => void,
): Promise<FigmaImportSceneNode> {
  const source = planned.source;
  const created = await createNodeForSource(plan, prototype, source, planned, api, onNodeCreated);
  const node = created.node;
  node.name = source.name;
  applyNodeGeometry(node, planned, isRoot ? 0 : planned.layout.x, isRoot ? 0 : planned.layout.y);
  applyNodeStyle(created, planned, prototype.tokens);
  setMetadata(node, prototype.source, screen.source, source.kind, source.name);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.sourceId, source.id);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.kind, source.kind);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.actionIds, JSON.stringify(source.actionIds));
  node.setPluginData(WORKBENCH_PLUGIN_DATA.bindingIds, JSON.stringify(source.bindingIds));
  node.setPluginData(WORKBENCH_PLUGIN_DATA.motionIds, JSON.stringify(source.motionIds));
  const document = prototype.source.document;
  node.setPluginData(
    WORKBENCH_PLUGIN_DATA.actions,
    JSON.stringify(document.actions.filter((action) => source.actionIds.includes(action.id))),
  );
  node.setPluginData(
    WORKBENCH_PLUGIN_DATA.bindings,
    JSON.stringify(document.bindings.filter((binding) => source.bindingIds.includes(binding.id))),
  );
  node.setPluginData(
    WORKBENCH_PLUGIN_DATA.motions,
    JSON.stringify(document.motions.filter((motion) => source.motionIds.includes(motion.id))),
  );
  node.setPluginData(WORKBENCH_PLUGIN_DATA.transformOrigin, JSON.stringify(source.style.transformOrigin));
  node.setPluginData(WORKBENCH_PLUGIN_DATA.sourceLayout, JSON.stringify(source.layout));
  node.setPluginData(WORKBENCH_PLUGIN_DATA.sourceNode, JSON.stringify(source));
  if (planned.layout.gridColumns !== null) {
    node.setPluginData(WORKBENCH_PLUGIN_DATA.gridColumns, String(planned.layout.gridColumns));
  }
  if (parent) parent.appendChild(node);
  if (created.kind === "frame") applyAutoLayout(created.node, planned);

  for (const child of planned.children) {
    if (created.kind !== "frame") throw new Error(`Node ${source.id} cannot contain children`);
    await createPlanNode(plan, prototype, screen, child, api, created.node, false, onNodeCreated);
  }
  if (planned.children.length === 0 && planned.generatedLabel) {
    if (created.kind !== "frame") throw new Error(`Node ${source.id} cannot contain a generated label`);
    const label = await createGeneratedLabel(planned, prototype, api, onNodeCreated);
    created.node.appendChild(label);
  }
  return node;
}

async function createNodeForSource(
  plan: FigmaImportPlan,
  prototype: FigmaImportPlanPrototype,
  source: PrototypeNode,
  planned: FigmaImportPlanNode,
  api: FigmaImportApi,
  onNodeCreated: (node: FigmaImportNode) => void,
): Promise<CreatedNode> {
  if (source.kind === "text") {
    const text = api.createText();
    onNodeCreated(text);
    await configureText(text, planned, prototype.assets, api, source.text);
    return { kind: "text", node: text };
  }
  if (source.kind === "image") {
    const asset = prototype.assets.get(source.assetId);
    if (!asset || asset.kind !== "image") throw new Error(`Missing image asset ${source.assetId}`);
    const bytes = plan.assets[figmaImportAssetKey(prototype.source.artifactVersionId, asset.id)];
    if (!bytes) throw new Error(`Missing verified image bytes ${asset.id}`);
    const image = api.createImage(bytes);
    const rectangle = api.createRectangle();
    onNodeCreated(rectangle);
    rectangle.fills = [{
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: imageScaleMode(source.fit),
      imageTransform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      scalingFactor: 1,
      rotation: 0,
      filters: {},
    }];
    rectangle.setPluginData("workbench.imageAssetId", asset.id);
    return { kind: "rectangle", node: rectangle };
  }
  if (source.kind === "icon") {
    const asset = prototype.assets.get(source.assetId);
    if (!asset || asset.kind !== "icon") throw new Error(`Missing icon asset ${source.assetId}`);
    const node = api.createNodeFromSvg(lucideSvg(asset));
    onNodeCreated(node);
    return { kind: "vector", node };
  }
  if (source.kind === "vector") {
    const node = api.createNodeFromSvg(vectorSvg(source, planned.style.fill));
    onNodeCreated(node);
    return { kind: "vector", node };
  }
  const node = api.createFrame();
  onNodeCreated(node);
  return { kind: "frame", node };
}

async function configureText(
  text: FigmaImportTextNode,
  planned: FigmaImportPlanNode,
  assets: Map<string, PrototypeAsset>,
  api: FigmaImportApi,
  characters: string,
) {
  const typography = planned.style.typography;
  if (!typography) throw new Error(`Text node ${planned.source.id} has no typography`);
  const fontAsset = findFontAsset(assets, typography.fontFamily, typography.fontWeight);
  const font = {
    family: typography.fontFamily,
    style: fontAsset?.style === "italic"
      ? `${fontStyleName(typography.fontWeight)} Italic`
      : fontStyleName(typography.fontWeight),
  };
  await api.loadFontAsync(font);
  text.fontName = font;
  text.characters = characters;
  text.fontSize = typography.fontSize;
  text.lineHeight = { unit: "PIXELS", value: typography.lineHeight };
  text.letterSpacing = { unit: "PIXELS", value: typography.letterSpacing };
  text.textAlignHorizontal = mapTextAlignHorizontal(typography.align);
  text.textCase = mapTextCase(typography.transform);
  text.textDecoration = mapTextDecoration(typography.decoration);
}

async function createGeneratedLabel(
  planned: FigmaImportPlanNode,
  prototype: FigmaImportPlanPrototype,
  api: FigmaImportApi,
  onNodeCreated: (node: FigmaImportNode) => void,
): Promise<FigmaImportTextNode> {
  const text = api.createText();
  onNodeCreated(text);
  const typography = planned.style.typography ?? {
    fontFamily: "Inter",
    fontSize: 14,
    fontWeight: 400,
    lineHeight: 20,
    letterSpacing: 0,
    align: "left" as const,
    transform: "none" as const,
    decoration: "none" as const,
  };
  const fontAsset = findFontAsset(prototype.assets, typography.fontFamily, typography.fontWeight);
  const font = { family: typography.fontFamily, style: fontStyleName(fontAsset?.weight ?? typography.fontWeight) };
  await api.loadFontAsync(font);
  text.fontName = font;
  text.characters = planned.generatedLabel ?? "";
  text.fontSize = typography.fontSize;
  text.name = `${planned.source.name} / label`;
  text.setPluginData(WORKBENCH_PLUGIN_DATA.generatedFor, planned.source.id);
  return text;
}

function applyNodeGeometry(node: FigmaImportSceneNode, planned: FigmaImportPlanNode, x: number, y: number) {
  const position = positionForTransformOrigin(
    x,
    y,
    planned.layout.width,
    planned.layout.height,
    planned.style.rotation,
    planned.source.style.transformOrigin,
  );
  node.x = position.x;
  node.y = position.y;
  node.resize(planned.layout.width, planned.layout.height);
  node.visible = planned.source.visible;
  node.opacity = planned.style.opacity;
  node.rotation = planned.style.rotation;
}

export function positionForTransformOrigin(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
  origin: { x: number; y: number },
): { x: number; y: number } {
  if (rotation === 0 || (origin.x === 0.5 && origin.y === 0.5)) return { x, y };
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const deltaX = (origin.x - 0.5) * width;
  const deltaY = (origin.y - 0.5) * height;
  const rotatedX = cos * deltaX - sin * deltaY;
  const rotatedY = sin * deltaX + cos * deltaY;
  return {
    x: x + deltaX - rotatedX,
    y: y + deltaY - rotatedY,
  };
}

function applyNodeStyle(
  created: CreatedNode,
  planned: FigmaImportPlanNode,
  tokens: Map<string, import("@workbench/workbench-contracts/prototype").PrototypeToken>,
) {
  const node = created.node;
  if (planned.style.fill) node.fills = [solidPaint(planned.style.fill)];
  else if (created.kind !== "text") node.fills = [];
  if (planned.style.stroke) {
    node.strokes = [solidPaint(planned.style.stroke.color)];
    node.strokeWeight = planned.style.stroke.width;
    node.strokeAlign = planned.style.stroke.position.toUpperCase() as "CENTER" | "INSIDE" | "OUTSIDE";
    if (planned.style.stroke.style !== "solid") node.dashPattern = planned.style.stroke.style === "dashed" ? [8, 4] : [2, 2];
  }
  if (created.kind !== "text") {
    const radii = planned.style.radii;
    if (radii.topLeft === radii.topRight && radii.topRight === radii.bottomRight && radii.bottomRight === radii.bottomLeft) {
      created.node.cornerRadius = radii.topLeft;
    } else if (created.kind === "frame" || created.kind === "rectangle") {
      created.node.topLeftRadius = radii.topLeft;
      created.node.topRightRadius = radii.topRight;
      created.node.bottomRightRadius = radii.bottomRight;
      created.node.bottomLeftRadius = radii.bottomLeft;
    }
  }
  const effects: FigmaEffect[] = planned.style.shadowTokenIds.flatMap((id) => {
    const token = tokens.get(id);
    if (!token || token.type !== "shadow") return [];
    return [{
      type: "DROP_SHADOW",
      color: colorObject(token.value.color),
      offset: { x: token.value.offsetX, y: token.value.offsetY },
      radius: token.value.blur,
      spread: token.value.spread,
      visible: true,
      blendMode: "NORMAL",
    }];
  });
  node.effects = effects;
}

function applyAutoLayout(node: FigmaImportFrameNode, planned: FigmaImportPlanNode) {
  const layout = planned.layout;
  if (layout.display === "flex") {
    node.layoutMode = layout.direction === "row" ? "HORIZONTAL" : "VERTICAL";
    node.itemSpacing = layout.gap;
    node.paddingTop = layout.padding.top;
    node.paddingRight = layout.padding.right;
    node.paddingBottom = layout.padding.bottom;
    node.paddingLeft = layout.padding.left;
    node.primaryAxisAlignItems = mapPrimaryAxis(layout.justify);
    node.counterAxisAlignItems = mapCounterAxis(layout.align);
  } else if (layout.display === "grid") {
    node.layoutMode = "GRID";
    node.paddingTop = layout.padding.top;
    node.paddingRight = layout.padding.right;
    node.paddingBottom = layout.padding.bottom;
    node.paddingLeft = layout.padding.left;
  } else {
    node.layoutMode = "NONE";
  }
  node.clipsContent = layout.overflow === "hidden";
}

function setMetadata(
  node: FigmaImportNode,
  prototype: FigmaImportPlanPrototype["source"],
  screen: { id: string; route: string } | null,
  kind: string,
  name: string,
) {
  node.setPluginData(WORKBENCH_PLUGIN_DATA.artifactId, prototype.artifactId);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.artifactVersionId, prototype.artifactVersionId);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.kind, kind);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.sourceId, prototype.document.documentId);
  node.setPluginData(WORKBENCH_PLUGIN_DATA.sourceRoute, screen?.route ?? "");
  node.name = name;
  if (screen) node.setPluginData(WORKBENCH_PLUGIN_DATA.screenId, screen.id);
}

function solidPaint(hex: string): FigmaPaint {
  return { type: "SOLID", color: colorObject(hex), opacity: colorAlpha(hex) };
}

function colorObject(hex: string) {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16) / 255,
    g: Number.parseInt(hex.slice(3, 5), 16) / 255,
    b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function colorAlpha(hex: string) {
  return hex.length === 9 ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1;
}

function imageScaleMode(fit: "contain" | "cover" | "fill" | "none") {
  return fit === "contain" ? "FIT" : fit === "cover" ? "FILL" : fit === "none" ? "CROP" : "STRETCH";
}

function mapPrimaryAxis(value: string): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
  return value === "center" ? "CENTER" : value === "end" ? "MAX" : value === "spaceBetween" ? "SPACE_BETWEEN" : "MIN";
}

function mapCounterAxis(value: string): "MIN" | "CENTER" | "MAX" | "BASELINE" {
  return value === "center" ? "CENTER" : value === "end" ? "MAX" : value === "stretch" ? "BASELINE" : "MIN";
}

export function mapTextAlignHorizontal(value: "left" | "center" | "right" | "justify"):
  "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" {
  return value === "center" ? "CENTER" : value === "right" ? "RIGHT" : value === "justify" ? "JUSTIFIED" : "LEFT";
}

export function mapTextCase(value: "none" | "uppercase" | "lowercase" | "capitalize"):
  "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" {
  return value === "uppercase" ? "UPPER" : value === "lowercase" ? "LOWER" : value === "capitalize" ? "TITLE" : "ORIGINAL";
}

function mapTextDecoration(value: "none" | "underline" | "lineThrough"): "NONE" | "UNDERLINE" | "STRIKETHROUGH" {
  return value === "underline" ? "UNDERLINE" : value === "lineThrough" ? "STRIKETHROUGH" : "NONE";
}

function findFontAsset(assets: Map<string, PrototypeAsset>, family: string, weight: number): PrototypeFontAsset | undefined {
  for (const asset of assets.values()) {
    if (asset.kind === "font" && asset.family === family && asset.weight === weight) return asset;
  }
  return undefined;
}

function fontStyleName(weight: number): string {
  if (weight >= 800) return "Extra Bold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "Semi Bold";
  if (weight >= 500) return "Medium";
  if (weight <= 300) return "Light";
  return "Regular";
}

function countPlanNodes(node: FigmaImportPlanNode): number {
  return 1 + node.children.reduce((count, child) => count + countPlanNodes(child), 0);
}

function vectorSvg(node: PrototypeVectorNode, fill: string | null): string {
  const paths = node.paths.map((path) => {
    const d = path.commands.map((command) => {
      switch (command.command) {
        case "moveTo": return `M ${command.x} ${command.y}`;
        case "lineTo": return `L ${command.x} ${command.y}`;
        case "horizontalTo": return `H ${command.x}`;
        case "verticalTo": return `V ${command.y}`;
        case "curveTo": return `C ${command.control1X} ${command.control1Y} ${command.control2X} ${command.control2Y} ${command.x} ${command.y}`;
        case "quadraticTo": return `Q ${command.controlX} ${command.controlY} ${command.x} ${command.y}`;
        case "close": return "Z";
      }
    }).join(" ");
    return `<path d="${escapeSvgAttribute(d)}" fill="${fill ?? "#000000"}" fill-rule="${path.fillRule === "evenodd" ? "evenodd" : "nonzero"}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${node.viewBox.minX} ${node.viewBox.minY} ${node.viewBox.width} ${node.viewBox.height}">${paths}</svg>`;
}

function lucideSvg(asset: PrototypeIconAsset): string {
  const icon = asset.iconName.toLowerCase();
  const paths: Record<string, string> = {
    check: "M20 6 9 17l-5-5",
    x: "M18 6 6 18M6 6l12 12",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    search: "m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z",
    menu: "M4 6h16M4 12h16M4 18h16",
    'arrow-left': "m19 12H5m7 7-7-7 7-7",
    'arrow-right': "M5 12h14m-7-7 7 7-7 7",
    home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z",
    heart: "M20.8 8.6c0 5.4-8.8 10.2-8.8 10.2S3.2 14 3.2 8.6A4.6 4.6 0 0 1 12 6a4.6 4.6 0 0 1 8.8 2.6Z",
  };
  const d = paths[icon] ?? "M4 4h16v16H4z";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" data-workbench-icon="${escapeSvgAttribute(asset.iconName)}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function escapeSvgAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const officialFigmaImportApi: FigmaImportApi = {
  createPage: () => figma.createPage() as unknown as FigmaImportPage,
  createFrame: () => figma.createFrame() as unknown as FigmaImportFrameNode,
  createText: () => figma.createText() as unknown as FigmaImportTextNode,
  createRectangle: () => figma.createRectangle() as unknown as FigmaImportRectangleNode,
  createImage: (bytes) => figma.createImage(bytes),
  createNodeFromSvg: (svg) => figma.createNodeFromSvg(svg) as unknown as FigmaImportVectorNode,
  loadFontAsync: (font) => figma.loadFontAsync(font),
  setCurrentPage: (page) => {
    return figma.setCurrentPageAsync(page as unknown as PageNode);
  },
  setSelection: (nodes) => {
    figma.currentPage.selection = nodes as unknown as SceneNode[];
  },
  scrollAndZoomIntoView: (nodes) => {
    figma.viewport.scrollAndZoomIntoView(nodes as unknown as SceneNode[]);
  },
};
