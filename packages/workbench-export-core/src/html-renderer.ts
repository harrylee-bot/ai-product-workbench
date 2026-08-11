import { createHash } from "node:crypto";
import {
  canonicalJson,
  designSystemDocumentSchema,
  materializeRuntimeDesignStyleSnapshot,
  orderBoardNodesByHierarchy,
  prototypeDocumentSchema,
  resolveExportBoardNodeSelection,
  workbenchExportRendererRevision,
  type DesignSystemDocument,
  type ExportSelection,
  type JsonValue,
  type ProjectReleaseBoardSnapshot,
  type PrototypeAsset,
  type PrototypeDocument,
  type PrototypeNode,
  type PrototypeToken,
} from "@workbench/workbench-contracts";
import * as LucideIcons from "lucide-react";
import { getStroke } from "perfect-freehand";
import { createElement, type ElementType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dataUri, escapeHtml, safeFileStem, safeScriptJson } from "./encoding.js";
import { createDeterministicZip } from "./archive.js";
import { TerminalExportError } from "./errors.js";
import { browserRuntimeSource } from "./runtime-source.js";
import type {
  ExportArtifactSource,
  ExportBinaryAsset,
  ExportBuildRequest,
  RenderedFontAsset,
  RenderedHtml,
} from "./types.js";

type RuntimePrototype = {
  id: string;
  documentId: string;
  initialScreenId: string;
  screens: PrototypeDocument["screens"];
  variables: PrototypeDocument["variables"];
  states: Array<{
    id: string;
    screenId: string;
    values: PrototypeDocument["states"][number]["values"];
    overrides: Array<{
      nodeId: string;
      visible?: boolean;
      enabled?: boolean;
      text?: string;
      style?: string;
      src?: string;
    }>;
  }>;
  actions: PrototypeDocument["actions"];
  bindings: Array<{
    id: string;
    nodeId: string;
    property: PrototypeDocument["bindings"][number]["property"];
    source: PrototypeDocument["bindings"][number]["source"];
  }>;
  imageAssets: Array<{ id: string; src: string }>;
  motions: Array<{
    id: string;
    nodeId: string;
    trigger: PrototypeDocument["motions"][number]["trigger"];
    stateId: string | null;
    actionId: string | null;
    property: PrototypeDocument["motions"][number]["property"];
    from: number;
    to: number;
    duration: number;
    delay: number;
    easing: PrototypeDocument["motions"][number]["easing"];
  }>;
};

type PrototypeStyle = PrototypeNode["style"];

const baseStyles = String.raw`*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#f4f5f7;color:#17191d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,textarea,select{font:inherit}.wb-export{min-height:100vh}.wb-export__header{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:10px 20px;background:#fff;border-bottom:1px solid #dfe2e7}.wb-export__title{margin:0;font-size:16px;line-height:1.4;font-weight:650}.wb-export__meta{font-size:12px;color:#69707d}.wb-export__content{padding:20px}.wb-board{position:relative;min-width:720px;min-height:360px;margin:0 0 24px;background:#e9ebef;background-image:linear-gradient(#d9dce2 1px,transparent 1px),linear-gradient(90deg,#d9dce2 1px,transparent 1px);background-size:24px 24px;border:1px solid #ced2d9;overflow:auto}.wb-board__node{position:absolute;display:flex;flex-direction:column;justify-content:center;min-width:120px;min-height:72px;padding:12px;background:#fff;border:1px solid #bcc2cc;box-shadow:0 2px 8px rgba(18,22,30,.08)}.wb-board__node--frame{justify-content:flex-start;min-width:0;min-height:0;padding:0;background:transparent;box-shadow:none}.wb-board__node--frame .wb-board__label{position:absolute;left:0;top:-20px;margin:0}.wb-board__node--drawing{display:block;min-width:0;min-height:0;padding:0;background:transparent;border:0;box-shadow:none}.wb-board__drawing{display:block;width:100%;height:100%;overflow:visible}.wb-board__kind{font-size:11px;color:#69707d;text-transform:uppercase}.wb-board__label{margin-top:4px;font-size:13px;font-weight:600}.wb-artifacts{display:grid;gap:20px}.wb-artifact{min-width:0;background:#fff;border:1px solid #d5d9e0}.wb-artifact__header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid #e1e4e9}.wb-artifact__title{margin:0;font-size:14px;font-weight:650}.wb-artifact__kind{font-size:11px;color:#69707d}.wb-artifact__body{padding:14px;overflow:auto}.wb-prototype__tabs{display:flex;gap:6px;margin-bottom:12px;overflow:auto}.wb-prototype__tab{height:32px;padding:0 12px;border:1px solid #cbd0d8;background:#fff;color:#3b414b;cursor:pointer}.wb-prototype__tab[aria-selected="true"]{background:#17191d;color:#fff;border-color:#17191d}.wb-prototype__stage{display:flex;justify-content:flex-start;overflow:auto;padding:16px;background:#e8eaee}.wb-screen{position:relative;flex:0 0 auto;background:#fff;box-shadow:0 8px 24px rgba(18,22,30,.14);overflow:hidden}.wb-node[hidden],.wb-screen[hidden]{display:none!important}.wb-node{letter-spacing:0}.wb-design-system{display:grid;gap:22px}.wb-design-system h3{margin:0 0 10px;font-size:13px}.wb-design-system__tokens,.wb-design-system__assets,.wb-design-system__items{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}.wb-design-system__token,.wb-design-system__asset,.wb-design-system__item{min-width:0;padding:10px;border:1px solid #dfe2e7;background:#fafbfc}.wb-design-system__swatch{display:block;width:100%;height:44px;margin-bottom:8px;border:1px solid rgba(0,0,0,.12)}.wb-design-system__label{display:block;font-size:12px;font-weight:650;overflow-wrap:anywhere}.wb-design-system__value{display:block;margin-top:3px;color:#69707d;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}.wb-design-system__image{display:block;width:100%;height:120px;margin-bottom:8px;object-fit:contain;background:#eef0f3}.wb-design-system__font-preview{display:flex;align-items:center;width:100%;height:72px;margin-bottom:8px;padding:8px;background:#eef0f3;font-size:28px;line-height:1;overflow:hidden}.wb-design-system__copy{margin:4px 0 0;color:#565d68;font-size:12px;line-height:1.5}.wb-json{max-height:70vh;margin:0;overflow:auto;padding:16px;background:#15171b;color:#e8eaed;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}.wb-image{display:block;max-width:100%;height:auto}.wb-document{white-space:pre-wrap;line-height:1.6}.wb-empty{padding:40px;text-align:center;color:#69707d}.wb-export--preview{min-height:100%;height:100%;overflow:hidden;background:#e8eaee}.wb-export--preview .wb-export__header,.wb-export--preview .wb-artifact__header,.wb-export--preview .wb-prototype__tabs{display:none}.wb-export--preview .wb-export__content,.wb-export--preview .wb-artifacts,.wb-export--preview .wb-artifact,.wb-export--preview .wb-artifact__body,.wb-export--preview .wb-prototype{height:100%;min-height:0}.wb-export--preview .wb-export__content{padding:0}.wb-export--preview .wb-artifacts{display:block}.wb-export--preview .wb-artifact{border:0;background:transparent}.wb-export--preview .wb-artifact__body{padding:0;overflow:hidden}.wb-export--preview .wb-prototype__stage{position:relative;display:block;width:100%;height:100%;padding:0;overflow:hidden;background:#e8eaee}.wb-export--preview .wb-screen{position:absolute;left:50%;top:50%;transform-origin:center center}.wb-export--preview .wb-board{margin:0;height:100%;min-height:0}.wb-export--preview .wb-document{padding:20px}@media(max-width:700px){.wb-export__content{padding:10px}.wb-export__header{padding:8px 12px}.wb-board{min-width:640px}.wb-artifact__body{padding:8px}.wb-design-system__tokens,.wb-design-system__assets,.wb-design-system__items{grid-template-columns:1fr}.wb-export--preview .wb-document{padding:12px}}`;

const previewViewportStyles = String.raw`.wb-export--preview{height:100vh;min-height:100vh}`;

export function renderExportHtml(request: ExportBuildRequest): RenderedHtml {
  if (request.initialScreenId !== undefined && request.selection.kind !== "artifact") {
    throw new TerminalExportError(
      "EXPORT_INITIAL_SCREEN_SELECTION_INVALID",
      "initialScreenId is supported only for a single Prototype Artifact selection",
    );
  }
  const selected = selectExportArtifacts(request.source.artifacts, request.selection, request.source.boardSnapshot.nodes);
  const runtimePrototypes: RuntimePrototype[] = [];
  const fontFaces: string[] = [];
  const fontAssets: RenderedFontAsset[] = [];
  const artifactMarkup = selected
    .map((artifact) => renderArtifact(
      artifact,
      runtimePrototypes,
      fontFaces,
      fontAssets,
      request.selection.kind === "artifact" ? request.selection.screenId : undefined,
      request.initialScreenId,
    ))
    .join("");
  const includeBoard = request.selection.kind !== "artifact";
  const boardMarkup = includeBoard
    ? renderBoard(request, selectExportBoardSnapshot(request.source.boardSnapshot, request.selection))
    : "";
  const title = selected.length === 1
    ? `${selected[0]!.title} v${selected[0]!.version}`
    : `Project release v${request.source.releaseVersion}`;
  const previewPresentation = request.presentation === "preview";
  const styles = `${baseStyles}\n${previewViewportStyles}\n${fontFaces.join("\n")}`;
  const runtimeData = { protocol: "workbench.export-runtime.v1", prototypes: runtimePrototypes } satisfies JsonValue;
  const bodyMarkup = `<main class="wb-export${previewPresentation ? " wb-export--preview" : ""}" data-wb-presentation="${previewPresentation ? "preview" : "standalone"}" data-wb-renderer-revision="${workbenchExportRendererRevision}"><header class="wb-export__header"><h1 class="wb-export__title">${escapeHtml(title)}</h1><div class="wb-export__meta">Release ${request.source.releaseVersion} · ${selected.length} artifact${selected.length === 1 ? "" : "s"}</div></header><div class="wb-export__content">${boardMarkup}<div class="wb-artifacts">${artifactMarkup || '<div class="wb-empty">This selection contains no exportable artifacts.</div>'}</div></div></main>`;
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="workbench-export-renderer" content="${workbenchExportRendererRevision}"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><div id="workbench-export-root">${bodyMarkup}</div><script id="workbench-export-data" type="application/json">${safeScriptJson(runtimeData)}</script><script>${browserRuntimeSource}</script></body></html>`;
  return { document, bodyMarkup, styles, runtimeSource: browserRuntimeSource, runtimeData, fontAssets, title };
}

export function htmlOutput(request: ExportBuildRequest) {
  const rendered = renderExportHtml(request);
  const bytes = Buffer.from(`${rendered.document}\n`, "utf8");
  const stem = request.selection.kind === "artifact"
    ? safeFileStem(selectExportArtifacts(request.source.artifacts, request.selection, request.source.boardSnapshot.nodes)[0]?.title ?? "artifact")
    : request.selection.kind === "board_nodes"
      ? `board-selection-${request.selection.nodeIds.length}`
      : `release-${request.source.releaseVersion}`;
  return {
    bytes,
    mediaType: "text/html; charset=utf-8",
    fileName: `${stem}.html`,
    validationTarget: "html" as const,
  };
}

/** Package the already-rendered standalone document without invoking another
 * renderer. This keeps ZIP and single-file deliveries byte-for-byte tied to
 * the same immutable HTML build. */
export async function htmlZipOutput(request: ExportBuildRequest) {
  const rendered = renderExportHtml(request);
  const document = `${rendered.document}\n`;
  const documentBytes = Buffer.from(document, "utf8");
  const documentSha256 = createHash("sha256").update(documentBytes).digest("hex");
  const manifest = `${canonicalJson({
    protocol: "workbench.html-package.v1",
    document: { path: "index.html", byteSize: documentBytes.byteLength, sha256: documentSha256 },
  })}\n`;
  const readme = "# 产品工作台 HTML 导出\n\n打开 `index.html` 即可离线预览。\n";
  const bytes = await createDeterministicZip([
    { name: "index.html", content: document },
    { name: "manifest.json", content: manifest },
    { name: "README.md", content: readme },
  ]);
  const selected = selectExportArtifacts(request.source.artifacts, request.selection, request.source.boardSnapshot.nodes);
  const stem = request.selection.kind === "artifact"
    ? safeFileStem(selected[0]?.title ?? "artifact")
    : request.selection.kind === "board_nodes"
      ? `board-selection-${request.selection.nodeIds.length}`
      : `release-${request.source.releaseVersion}`;
  return {
    bytes,
    mediaType: "application/zip",
    fileName: `${stem}.zip`,
    validationTarget: "html" as const,
    validationBytes: documentBytes,
  };
}

export function selectExportArtifacts(
  artifacts: ExportArtifactSource[],
  selection: ExportSelection,
  boardNodes: Array<{
    id: string;
    kind: string;
    parentNodeId: string | null;
    artifactId: string | null;
    artifactVersionId: string | null;
  }>,
) {
  if (selection.kind === "release") return artifacts;
  if (selection.kind === "board" || selection.kind === "board_nodes") {
    const selectedNodes = selectedExportBoardNodes(boardNodes, selection);
    const ids = new Set(selectedNodes.flatMap((node) => node.artifactVersionId ? [node.artifactVersionId] : []));
    return artifacts.filter((artifact) => ids.has(artifact.artifactVersionId));
  }
  const selected = artifacts.find((artifact) => artifact.artifactId === selection.artifactId
    && artifact.artifactVersionId === selection.artifactVersionId);
  if (!selected) {
    throw new TerminalExportError(
      "EXPORT_SELECTION_NOT_PINNED",
      "The selected ArtifactVersion is not pinned by this ProjectRelease",
    );
  }
  return [selected];
}

export function selectExportBoardSnapshot(
  board: ProjectReleaseBoardSnapshot,
  selection: ExportSelection,
): ProjectReleaseBoardSnapshot {
  if (selection.kind !== "board_nodes") return board;
  const selected = selectedExportBoardNodes(board.nodes, selection);
  const selectedIds = new Set(selected.map((node) => node.id));
  const absolutePositions = absoluteBoardNodePositions(board.nodes);
  const projected = selected.map((node) => (
    node.parentNodeId === null || selectedIds.has(node.parentNodeId)
      ? { ...node, position: { ...node.position } }
      : {
          ...node,
          parentNodeId: null,
          position: { ...absolutePositions.get(node.id)! },
        }
  ));
  const nextOrder = new Map<string | null, number>();
  const nodes = orderBoardNodesByHierarchy(projected).map((node) => {
    const order = nextOrder.get(node.parentNodeId) ?? 0;
    nextOrder.set(node.parentNodeId, order + 1);
    return { ...node, order };
  });
  return {
    ...board,
    nodes,
    edges: board.edges.filter((edge) => (
      selectedIds.has(edge.sourceNodeId) && selectedIds.has(edge.targetNodeId)
    )),
  };
}

function selectedExportBoardNodes<Node extends {
  id: string;
  kind: string;
  parentNodeId: string | null;
}>(
  boardNodes: readonly Node[],
  selection: ExportSelection,
): Node[] {
  if (selection.kind !== "board_nodes") return [...boardNodes];
  const resolution = resolveExportBoardNodeSelection(boardNodes, selection.nodeIds);
  if (resolution.missingNodeIds.length > 0) {
    throw new TerminalExportError(
      "EXPORT_BOARD_NODE_SELECTION_NOT_PINNED",
      "Every selected Board node must belong to this ProjectRelease",
    );
  }
  return resolution.selectedNodes;
}

function renderBoard(request: ExportBuildRequest, board: ProjectReleaseBoardSnapshot) {
  if (board.nodes.length === 0) return "";
  const positions = absoluteBoardNodePositions(board.nodes);
  const minX = Math.min(...board.nodes.map((node) => positions.get(node.id)!.x));
  const minY = Math.min(...board.nodes.map((node) => positions.get(node.id)!.y));
  const maxX = Math.max(...board.nodes.map((node) => positions.get(node.id)!.x + (node.size?.width ?? 240)));
  const maxY = Math.max(...board.nodes.map((node) => positions.get(node.id)!.y + (node.size?.height ?? 140)));
  const width = Math.max(720, maxX - minX + 80);
  const height = Math.max(360, maxY - minY + 80);
  const titles = new Map(request.source.artifacts.map((artifact) => [artifact.artifactId, artifact.title]));
  const nodes = orderBoardNodesByHierarchy(board.nodes)
    .map((node, stackIndex) => renderBoardNode(node, positions, titles, minX, minY, stackIndex))
    .join("");
  return `<section aria-label="Release board" class="wb-board" style="width:${width}px;height:${height}px">${nodes}</section>`;
}

function renderBoardNode(
  node: ProjectReleaseBoardSnapshot["nodes"][number],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  titles: ReadonlyMap<string, string>,
  minX: number,
  minY: number,
  stackIndex: number,
) {
  const position = positions.get(node.id)!;
  const left = position.x - minX + 40;
  const top = position.y - minY + 40;
  const naturalWidth = node.size?.width ?? 240;
  const naturalHeight = node.size?.height ?? 140;
  if (node.data.nodeType === "frame") {
    const fill = node.data.fill ?? "transparent";
    return `<div class="wb-board__node wb-board__node--frame" data-board-node-id="${escapeHtml(node.id)}" style="left:${left}px;top:${top}px;width:${naturalWidth}px;height:${naturalHeight}px;z-index:${stackIndex};background:${escapeHtml(fill)};border-color:${escapeHtml(node.data.stroke)}"><span class="wb-board__label">${escapeHtml(node.data.title)}</span></div>`;
  }
  if (node.data.nodeType === "drawing") {
    const outline = getStroke(node.data.stroke.points, {
      size: node.data.stroke.size,
      thinning: node.data.stroke.thinning,
      smoothing: node.data.stroke.smoothing,
      streamline: node.data.stroke.streamline,
      simulatePressure: node.data.stroke.simulatePressure,
    });
    const intrinsicSize = node.data.stroke.intrinsicSize;
    return `<div class="wb-board__node wb-board__node--drawing" data-board-node-id="${escapeHtml(node.id)}" style="left:${left}px;top:${top}px;width:${naturalWidth}px;height:${naturalHeight}px;z-index:${stackIndex}"><svg class="wb-board__drawing" viewBox="0 0 ${intrinsicSize.width} ${intrinsicSize.height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(node.data.title)}"><path d="${escapeHtml(freehandOutlinePath(outline))}" fill="${escapeHtml(node.data.stroke.color)}"></path></svg></div>`;
  }
  const widthValue = Math.max(120, naturalWidth);
  const heightValue = Math.max(72, naturalHeight);
  const label = node.artifactId ? titles.get(node.artifactId) : node.data.title;
  return `<div class="wb-board__node" data-board-node-id="${escapeHtml(node.id)}" style="left:${left}px;top:${top}px;width:${widthValue}px;height:${heightValue}px;z-index:${stackIndex}"><span class="wb-board__kind">${escapeHtml(node.data.artifactKind)}</span><span class="wb-board__label">${escapeHtml(label ?? node.data.title)}</span></div>`;
}

function absoluteBoardNodePositions(nodes: ProjectReleaseBoardSnapshot["nodes"]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  const resolve = (node: ProjectReleaseBoardSnapshot["nodes"][number]): { x: number; y: number } => {
    const cached = positions.get(node.id);
    if (cached) return cached;
    const parent = node.parentNodeId === null ? undefined : byId.get(node.parentNodeId);
    const parentPosition = parent ? resolve(parent) : { x: 0, y: 0 };
    const position = { x: parentPosition.x + node.position.x, y: parentPosition.y + node.position.y };
    positions.set(node.id, position);
    return position;
  };
  nodes.forEach(resolve);
  return positions;
}

function freehandOutlinePath(points: number[][]): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  const last = points.at(-1)!;
  const commands = points.slice(1, -1).map((point, index) => {
    const next = points[index + 2]!;
    return `Q ${point[0]} ${point[1]} ${(point[0] + next[0]) / 2} ${(point[1] + next[1]) / 2}`;
  });
  return [`M ${first[0]} ${first[1]}`, ...commands, `Q ${last[0]} ${last[1]} ${first[0]} ${first[1]}`, "Z"].join(" ");
}

function renderArtifact(
  artifact: ExportArtifactSource,
  runtimePrototypes: RuntimePrototype[],
  fontFaces: string[],
  fontAssets: RenderedFontAsset[],
  screenId?: string,
  initialScreenId?: string,
) {
  if ((screenId !== undefined || initialScreenId !== undefined) && artifact.kind !== "prototype") {
    throw new TerminalExportError(
      "EXPORT_SELECTION_SCREEN_KIND_INVALID",
      "screenId and initialScreenId are supported only for Prototype Artifact selections",
    );
  }
  const body = artifact.kind === "prototype"
    ? renderPrototypeArtifact(
        artifact,
        runtimePrototypes,
        fontFaces,
        fontAssets,
        screenId,
        initialScreenId,
      )
    : artifact.kind === "design_system"
      ? renderDesignSystemArtifact(artifact, fontFaces, fontAssets)
    : renderGenericArtifact(artifact);
  return `<article class="wb-artifact" data-artifact-id="${escapeHtml(artifact.artifactId)}" data-artifact-version-id="${escapeHtml(artifact.artifactVersionId)}"><header class="wb-artifact__header"><h2 class="wb-artifact__title">${escapeHtml(artifact.title)}</h2><span class="wb-artifact__kind">${escapeHtml(artifact.kind)} · v${artifact.version}</span></header><div class="wb-artifact__body">${body}</div></article>`;
}

function renderDesignSystemArtifact(
  artifact: ExportArtifactSource,
  fontFaces: string[],
  fontAssets: RenderedFontAsset[],
) {
  const parsed = designSystemDocumentSchema.safeParse(jsonContent(artifact));
  if (!parsed.success) {
    throw new TerminalExportError(
      "EXPORT_DESIGN_SYSTEM_IR_INVALID",
      `Design System ${artifact.artifactVersionId} does not conform to workbench.design-system.v1`,
      { cause: parsed.error },
    );
  }
  const document = parsed.data;
  const byAssetId = new Map(artifact.assets.map((asset) => [asset.assetId, asset]));
  let materialized;
  try {
    materialized = materializeRuntimeDesignStyleSnapshot({
      projectId: "export",
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.artifactVersionId,
      checksum: artifact.checksum,
      document,
      assetPins: artifact.assets.map((asset) => ({
        assetId: asset.assetId,
        kind: asset.kind,
        blobId: asset.blobId,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
      })),
    });
  } catch (cause) {
    throw new TerminalExportError(
      "EXPORT_DESIGN_SYSTEM_ASSET_PIN_MISMATCH",
      `Design System ${artifact.artifactVersionId} assets do not match its immutable document`,
      { cause },
    );
  }

  for (const asset of document.assets) {
    if (asset.kind !== "font") continue;
    const binary = requireDesignSystemAsset(asset, byAssetId);
    fontFaces.push(`@font-face{font-family:${cssString(asset.family)};src:url(${cssString(dataUri(binary.mediaType, binary.bytes))});font-style:${asset.style};font-weight:${asset.weight};font-display:swap}`);
    fontAssets.push(renderedFontAsset(artifact.artifactVersionId, asset, binary));
  }

  const tokens = materialized.tokens.map((token) => {
    const serialized = designTokenValue(token.value);
    const swatch = token.type === "color" && typeof token.value === "string"
      ? `<span class="wb-design-system__swatch" style="background:${escapeHtml(token.value)}"></span>`
      : "";
    return `<div class="wb-design-system__token">${swatch}<span class="wb-design-system__label">${escapeHtml(token.path)}</span><span class="wb-design-system__value">${escapeHtml(serialized)}</span></div>`;
  }).join("");
  const assets = document.assets.map((asset) => {
    const binary = requireDesignSystemAsset(asset, byAssetId);
    const preview = asset.kind === "image"
      ? `<img class="wb-design-system__image" src="${escapeHtml(dataUri(binary.mediaType, binary.bytes))}" alt="${escapeHtml(asset.name)}">`
      : `<span class="wb-design-system__font-preview" data-wb-font-family="${escapeHtml(asset.family)}" style="${escapeHtml(`font-family:${cssString(asset.family)};font-style:${asset.style};font-weight:${asset.weight}`)}">Aa</span>`;
    const detail = asset.kind === "font"
      ? `${asset.family} · ${asset.weight} ${asset.style}`
      : `${asset.width} × ${asset.height}`;
    return `<div class="wb-design-system__asset" data-wb-asset-id="${escapeHtml(asset.id)}" data-wb-asset-sha256="${escapeHtml(asset.sha256)}">${preview}<span class="wb-design-system__label">${escapeHtml(asset.name)}</span><span class="wb-design-system__value">${escapeHtml(detail)} · ${escapeHtml(asset.mediaType)}</span></div>`;
  }).join("");
  const principles = renderDesignSystemItems(document.principles);
  const guidelines = renderDesignSystemItems(document.guidelines);
  const components = renderDesignSystemItems(document.components.map((component) => ({
    title: component.name,
    description: `${component.description}\n${component.usage.summary}`,
  })));
  return `<section class="wb-design-system" data-wb-design-system="${escapeHtml(document.documentId)}"><section><h3>Tokens</h3><div class="wb-design-system__tokens">${tokens || '<div class="wb-empty">No tokens</div>'}</div></section><section><h3>Assets</h3><div class="wb-design-system__assets">${assets || '<div class="wb-empty">No assets</div>'}</div></section><section><h3>Principles</h3><div class="wb-design-system__items">${principles || '<div class="wb-empty">No principles</div>'}</div></section><section><h3>Guidelines</h3><div class="wb-design-system__items">${guidelines || '<div class="wb-empty">No guidelines</div>'}</div></section><section><h3>Components</h3><div class="wb-design-system__items">${components || '<div class="wb-empty">No components</div>'}</div></section></section>`;
}

function renderDesignSystemItems(items: ReadonlyArray<{ title: string; description: string }>) {
  return items.map((item) => `<div class="wb-design-system__item"><span class="wb-design-system__label">${escapeHtml(item.title)}</span><p class="wb-design-system__copy">${escapeHtml(item.description)}</p></div>`).join("");
}

function designTokenValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function requireDesignSystemAsset(
  asset: DesignSystemDocument["assets"][number],
  byAssetId: Map<string, ExportBinaryAsset>,
) {
  const binary = byAssetId.get(asset.id);
  if (
    !binary
    || binary.kind !== asset.kind
    || binary.blobId !== asset.blobId
    || binary.sha256 !== asset.sha256
    || binary.mediaType !== asset.mediaType
    || binary.byteSize !== asset.byteSize
    || binary.bytes.byteLength !== binary.byteSize
    || createHash("sha256").update(binary.bytes).digest("hex") !== binary.sha256
  ) {
    throw new TerminalExportError(
      "EXPORT_DESIGN_SYSTEM_ASSET_IDENTITY_MISMATCH",
      `Design System asset ${asset.id} is missing or changed`,
    );
  }
  return binary;
}

function renderPrototypeArtifact(
  artifact: ExportArtifactSource,
  runtimePrototypes: RuntimePrototype[],
  fontFaces: string[],
  fontAssets: RenderedFontAsset[],
  screenId?: string,
  initialScreenId?: string,
) {
  const content = jsonContent(artifact);
  const parsed = prototypeDocumentSchema.safeParse(content);
  if (!parsed.success) {
    throw new TerminalExportError(
      "EXPORT_PROTOTYPE_IR_INVALID",
      `Prototype ${artifact.artifactVersionId} does not conform to workbench.prototype.v1`,
      { cause: parsed.error },
    );
  }
  const document = parsed.data;
  const tokens = new Map(document.tokens.map((token) => [token.id, token]));
  const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
  const blobs = new Map(artifact.assets.map((asset) => [asset.assetId, asset]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const prefix = `p-${createHash("sha256").update(artifact.artifactVersionId).digest("hex").slice(0, 12)}`;
  const screens = screenId === undefined
    ? document.screens
    : document.screens.filter((screen) => screen.id === screenId);
  if (screens.length === 0) {
    throw new TerminalExportError(
      "EXPORT_SELECTION_SCREEN_NOT_FOUND",
      `Screen ${screenId} does not exist in Prototype ${artifact.artifactVersionId}`,
    );
  }
  const resolvedInitialScreenId = initialScreenId ?? screens[0]!.id;
  if (!screens.some((screen) => screen.id === resolvedInitialScreenId)) {
    throw new TerminalExportError(
      "EXPORT_INITIAL_SCREEN_NOT_FOUND",
      `Initial screen ${resolvedInitialScreenId} does not exist in the rendered Prototype ${artifact.artifactVersionId}`,
    );
  }

  for (const asset of document.assets) {
    if (asset.kind !== "font") continue;
    const blob = requireAssetBlob(asset, blobs);
    fontFaces.push(`@font-face{font-family:${cssString(asset.family)};src:url(${cssString(dataUri(blob.mediaType, blob.bytes))});font-style:${asset.style};font-weight:${asset.weight};font-display:swap}`);
    fontAssets.push(renderedFontAsset(artifact.artifactVersionId, asset, blob));
  }

  const screenMarkup = screens.map((screen) => {
    const root = nodes.get(screen.rootNodeId);
    if (!root) throw new TerminalExportError("EXPORT_PROTOTYPE_ROOT_MISSING", `Screen ${screen.id} has no root node`);
    return `<section class="wb-screen" data-wb-screen="${escapeHtml(screen.id)}" style="width:${screen.viewport.width}px;height:${screen.viewport.height}px"${screen.id === resolvedInitialScreenId ? "" : " hidden"}>${renderNode(root, {
      nodes,
      tokens,
      assets,
      blobs,
      bindings: new Map(document.bindings.map((binding) => [binding.id, binding])),
      variables: new Map(document.variables.map((variable) => [variable.path, variable.initialValue])),
    })}</section>`;
  }).join("");
  const tabs = screens.map((screen) => `<button class="wb-prototype__tab" type="button" data-wb-screen-target="${escapeHtml(screen.id)}" role="tab" aria-selected="${screen.id === resolvedInitialScreenId}">${escapeHtml(screen.name)}</button>`).join("");
  runtimePrototypes.push(runtimeModel(
    prefix,
    document,
    tokens,
    assets,
    blobs,
    screens,
    resolvedInitialScreenId,
  ));
  return `<section class="wb-prototype" data-wb-prototype="${prefix}"><nav class="wb-prototype__tabs" role="tablist" aria-label="Prototype screens">${tabs}</nav><div class="wb-prototype__stage">${screenMarkup}</div></section>`;
}

type RenderContext = {
  nodes: Map<string, PrototypeNode>;
  tokens: Map<string, PrototypeToken>;
  assets: Map<string, PrototypeAsset>;
  blobs: Map<string, ExportBinaryAsset>;
  bindings: Map<string, PrototypeDocument["bindings"][number]>;
  variables: Map<string, PrototypeDocument["variables"][number]["initialValue"]>;
};

function renderNode(node: PrototypeNode, context: RenderContext): string {
  const attributes = `class="wb-node wb-node--${node.kind}" data-wb-node="${escapeHtml(node.id)}" data-wb-rotation="${node.style.rotation}" data-wb-transform-origin-x="${node.style.transformOrigin.x}" data-wb-transform-origin-y="${node.style.transformOrigin.y}" style="${escapeHtml(nodeStyle(node, context.tokens))}"${node.visible ? "" : " hidden"}`;
  if (node.kind === "frame") {
    return `<div ${attributes}>${node.childIds.map((id) => renderChild(id, context)).join("")}</div>`;
  }
  if (node.kind === "form") {
    return `<form ${attributes}>${node.childIds.map((id) => renderChild(id, context)).join("")}</form>`;
  }
  if (node.kind === "text") return `<div ${attributes} data-wb-text="true">${escapeHtml(node.text)}</div>`;
  if (node.kind === "button") {
    return `<button ${attributes} type="${node.buttonType}"${node.disabled ? " disabled" : ""}><span data-wb-content="label">${escapeHtml(node.label)}</span>${node.childIds.map((id) => renderChild(id, context)).join("")}</button>`;
  }
  if (node.kind === "input") return renderInput(node, attributes, context);
  if (node.kind === "image") {
    const asset = context.assets.get(node.assetId);
    if (!asset || asset.kind !== "image") throw new TerminalExportError("EXPORT_IMAGE_ASSET_MISSING", `Image node ${node.id} has no valid asset`);
    const blob = requireAssetBlob(asset, context.blobs);
    return `<img ${attributes} src="${escapeHtml(dataUri(blob.mediaType, blob.bytes))}" alt="${escapeHtml(node.alt)}" style="${escapeHtml(`${nodeStyle(node, context.tokens)};object-fit:${node.fit}`)}">`;
  }
  if (node.kind === "icon") {
    const asset = context.assets.get(node.assetId);
    if (!asset || asset.kind !== "icon") throw new TerminalExportError("EXPORT_ICON_ASSET_MISSING", `Icon node ${node.id} has no valid Lucide asset`);
    return `<span ${attributes} role="img" aria-label="${escapeHtml(node.accessibilityLabel ?? asset.name)}">${renderLucideIcon(asset.iconName)}</span>`;
  }
  return `<svg ${attributes} viewBox="${node.viewBox.minX} ${node.viewBox.minY} ${node.viewBox.width} ${node.viewBox.height}" aria-hidden="true">${node.paths.map((path) => `<path d="${escapeHtml(vectorPath(path.commands))}" fill-rule="${path.fillRule}"></path>`).join("")}</svg>`;
}

function renderChild(nodeId: string, context: RenderContext) {
  const child = context.nodes.get(nodeId);
  if (!child) throw new TerminalExportError("EXPORT_PROTOTYPE_CHILD_MISSING", `Prototype child node ${nodeId} is missing`);
  return renderNode(child, context);
}

function renderInput(
  node: Extract<PrototypeNode, { kind: "input" }>,
  attributes: string,
  context: RenderContext,
) {
  const common = `${attributes} name="${escapeHtml(node.fieldName)}" aria-label="${escapeHtml(node.label)}"${node.required ? " required" : ""}${node.disabled ? " disabled" : ""}`;
  const valueBinding = node.bindingIds
    .map((bindingId) => context.bindings.get(bindingId))
    .find((binding) => binding?.property === "value");
  const initialValue = valueBinding?.source.kind === "variable"
    ? context.variables.get(valueBinding.source.path) ?? null
    : null;
  if (node.inputType === "textarea") return `<textarea ${common} placeholder="${escapeHtml(node.placeholder)}">${escapeHtml(String(initialValue ?? ""))}</textarea>`;
  if (node.inputType === "select") {
    const placeholder = initialValue === ""
      ? `<option value="" selected>${escapeHtml(node.placeholder)}</option>`
      : "";
    const options = node.options.map((option) => `<option value="${escapeHtml(option.value)}"${option.disabled ? " disabled" : ""}${option.value === initialValue ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
    return `<select ${common}>${placeholder}${options}</select>`;
  }
  if (node.inputType === "checkbox") return `<input ${common} type="checkbox" value="true"${initialValue === true ? " checked" : ""}>`;
  if (node.inputType === "radio") return `<input ${common} type="radio" value="${escapeHtml(node.optionValue ?? "")}"${initialValue === node.optionValue ? " checked" : ""}>`;
  return `<input ${common} type="${node.inputType}" value="${escapeHtml(String(initialValue ?? ""))}" placeholder="${escapeHtml(node.placeholder)}">`;
}

function nodeStyle(
  node: PrototypeNode,
  tokens: Map<string, PrototypeToken>,
  style: PrototypeStyle = node.style,
) {
  const { layout } = node;
  const padding = [layout.padding.top, layout.padding.right, layout.padding.bottom, layout.padding.left]
    .map((value) => `${numeric(value, tokens)}px`).join(" ");
  const declarations = [
    `position:${layout.mode === "absolute" ? "absolute" : "relative"}`,
    `left:${layout.mode === "absolute" ? `${numeric(layout.x, tokens)}px` : "auto"}`,
    `top:${layout.mode === "absolute" ? `${numeric(layout.y, tokens)}px` : "auto"}`,
    `width:${numeric(layout.width, tokens)}px`,
    `height:${numeric(layout.height, tokens)}px`,
    `display:${layout.display}`,
    `flex-direction:${layout.direction}`,
    `gap:${numeric(layout.gap, tokens)}px`,
    `padding:${padding}`,
    `align-items:${alignValue(layout.align)}`,
    `justify-content:${justifyValue(layout.justify)}`,
    ...(layout.display === "grid" && layout.gridColumns ? [`grid-template-columns:repeat(${layout.gridColumns},minmax(0,1fr))`] : []),
    `overflow:${layout.overflow}`,
    ...styleDeclarations(style, tokens, node.kind),
  ];
  return declarations.join(";");
}

function styleDeclarations(
  style: PrototypeStyle,
  tokens: Map<string, PrototypeToken>,
  nodeKind: PrototypeNode["kind"],
) {
  const shadows = style.shadowTokenIds.map((id) => {
    const token = tokens.get(id);
    if (!token || token.type !== "shadow") throw invalidToken(id);
    return `${token.value.offsetX}px ${token.value.offsetY}px ${token.value.blur}px ${token.value.spread}px ${token.value.color}`;
  });
  const fillColor = style.fill ? color(style.fill, tokens) : null;
  const foregroundFill = nodeKind === "text" || nodeKind === "icon" || nodeKind === "vector";
  const declarations = [
    `opacity:${style.opacity}`,
    `transform:rotate(${style.rotation}deg)`,
    "transform-box:border-box",
    `transform-origin:${style.transformOrigin.x * 100}% ${style.transformOrigin.y * 100}%`,
    ...(fillColor
      ? foregroundFill
        ? [`color:${fillColor}`, ...(nodeKind === "vector" ? ["fill:currentColor"] : [])]
        : [`background-color:${fillColor}`, `color:${contrastTextColor(fillColor)}`]
      : []),
    ...(style.stroke ? [
      `border:${numeric(style.stroke.width, tokens)}px ${style.stroke.style} ${color(style.stroke.color, tokens)}`,
    ] : ["border:none"]),
    `border-radius:${numeric(style.radii.topLeft, tokens)}px ${numeric(style.radii.topRight, tokens)}px ${numeric(style.radii.bottomRight, tokens)}px ${numeric(style.radii.bottomLeft, tokens)}px`,
    ...(shadows.length ? [`box-shadow:${shadows.join(",")}`] : []),
  ];
  if (style.typography) {
    declarations.push(
      `font-family:${cssString(stringValue(style.typography.fontFamily, tokens))}`,
      `font-size:${numeric(style.typography.fontSize, tokens)}px`,
      `font-weight:${numeric(style.typography.fontWeight, tokens)}`,
      `line-height:${numeric(style.typography.lineHeight, tokens)}px`,
      `letter-spacing:${numeric(style.typography.letterSpacing, tokens)}px`,
      `text-align:${style.typography.align}`,
      `text-transform:${style.typography.transform}`,
      `text-decoration:${style.typography.decoration === "lineThrough" ? "line-through" : style.typography.decoration}`,
    );
  }
  return declarations;
}

/** Keep generated labels readable when a node uses a dark fill without an
 * explicit foreground token. Prototype IR currently models fill as the
 * node background, so this derived color is the stable fallback for text,
 * buttons, inputs, and descendants that inherit the node color. */
function contrastTextColor(hex: string) {
  const normalized = hex.slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = [red, green, blue]
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lightContrast = 1.05 / (luminance + 0.05);
  const darkLuminance = 0.010329823029626936;
  const darkContrast = (luminance + 0.05) / (darkLuminance + 0.05);
  return lightContrast >= darkContrast ? "#fff" : "#17191d";
}

function runtimeModel(
  id: string,
  document: PrototypeDocument,
  tokens: Map<string, PrototypeToken>,
  assets: Map<string, PrototypeAsset>,
  blobs: Map<string, ExportBinaryAsset>,
  screens: PrototypeDocument["screens"],
  initialScreenId: string,
): RuntimePrototype {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const screenIds = new Set(screens.map((screen) => screen.id));
  const selectedNodeIds = new Set(document.nodes
    .filter((node) => screenIds.has(node.screenId))
    .map((node) => node.id));
  const states = document.states.filter((state) => screenIds.has(state.screenId));
  const stateIds = new Set(states.map((state) => state.id));
  const actions = document.actions
    .filter((action) => selectedNodeIds.has(action.nodeId))
    .filter((action) => action.kind !== "navigate" || screenIds.has(action.targetScreenId))
    .filter((action) => action.kind !== "setState" || stateIds.has(action.targetStateId))
    .filter((action) => action.kind !== "submit" || action.successStateId === null || stateIds.has(action.successStateId));
  const actionIds = new Set(actions.map((action) => action.id));
  return {
    id,
    documentId: document.documentId,
    initialScreenId,
    screens,
    variables: document.variables,
    states: states.map((state) => ({
      id: state.id,
      screenId: state.screenId,
      values: state.values,
      overrides: state.overrides.map((override) => {
        const node = nodes.get(override.nodeId);
        const asset = override.assetId ? assets.get(override.assetId) : undefined;
        const blob = asset && asset.kind === "image" ? requireAssetBlob(asset, blobs) : undefined;
        return {
          nodeId: override.nodeId,
          ...(override.visible === undefined ? {} : { visible: override.visible }),
          ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
          ...(override.text === undefined ? {} : { text: override.text }),
          ...(override.style === undefined || !node ? {} : { style: nodeStyle(node, tokens, override.style) }),
          ...(blob ? { src: dataUri(blob.mediaType, blob.bytes) } : {}),
        };
      }),
    })),
    actions,
    bindings: document.bindings.filter((binding) => selectedNodeIds.has(binding.nodeId)).map((binding) => ({
      id: binding.id,
      nodeId: binding.nodeId,
      property: binding.property,
      source: binding.source,
    })),
    imageAssets: document.assets
      .filter((asset): asset is Extract<PrototypeAsset, { kind: "image" }> => asset.kind === "image")
      .map((asset) => {
        const blob = requireAssetBlob(asset, blobs);
        return { id: asset.id, src: dataUri(blob.mediaType, blob.bytes) };
      }),
    motions: document.motions
      .filter((motion) => selectedNodeIds.has(motion.nodeId))
      .filter((motion) => motion.stateId === null || stateIds.has(motion.stateId))
      .filter((motion) => motion.actionId === null || actionIds.has(motion.actionId))
      .map((motion) => ({
      ...motion,
      duration: numeric(motion.duration, tokens),
      delay: numeric(motion.delay, tokens),
      })),
  };
}

function renderGenericArtifact(artifact: ExportArtifactSource) {
  if (artifact.kind === "image" && artifact.content instanceof Uint8Array) {
    return `<img class="wb-image" src="${escapeHtml(dataUri(artifact.contentMediaType, artifact.content))}" alt="${escapeHtml(artifact.title)}">`;
  }
  if ((artifact.kind === "code" || artifact.kind === "document") && artifact.content instanceof Uint8Array) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(artifact.content);
    return artifact.kind === "code"
      ? `<pre class="wb-json"><code>${escapeHtml(decoded)}</code></pre>`
      : `<div class="wb-document">${escapeHtml(decoded)}</div>`;
  }
  const value = artifact.content instanceof Uint8Array
    ? { mediaType: artifact.contentMediaType, sha256: artifact.checksum, byteSize: artifact.content.byteLength }
    : artifact.content;
  return `<pre class="wb-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function jsonContent(artifact: ExportArtifactSource): JsonValue {
  if (!(artifact.content instanceof Uint8Array)) return artifact.content;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.content)) as JsonValue;
  } catch (cause) {
    throw new TerminalExportError(
      "EXPORT_ARTIFACT_JSON_INVALID",
      `ArtifactVersion ${artifact.artifactVersionId} is not valid UTF-8 JSON`,
      { cause },
    );
  }
}

function requireAssetBlob(
  asset: Extract<PrototypeAsset, { kind: "image" | "font" }>,
  blobs: Map<string, ExportBinaryAsset>,
) {
  const blob = blobs.get(asset.id);
  if (!blob
    || blob.assetId !== asset.id
    || blob.kind !== asset.kind
    || blob.blobId !== asset.blobId
    || blob.sha256 !== asset.sha256
    || blob.mediaType !== asset.mediaType
    || blob.byteSize !== asset.byteSize
    || blob.bytes.byteLength !== blob.byteSize
    || createHash("sha256").update(blob.bytes).digest("hex") !== blob.sha256) {
    throw new TerminalExportError("EXPORT_ASSET_IDENTITY_MISMATCH", `Asset Blob ${asset.blobId} is missing or changed`);
  }
  return blob;
}

function renderedFontAsset(
  artifactVersionId: string,
  asset: Extract<PrototypeAsset | DesignSystemDocument["assets"][number], { kind: "font" }>,
  binary: ExportBinaryAsset,
): RenderedFontAsset {
  return {
    artifactVersionId,
    assetId: asset.id,
    family: asset.family,
    weight: asset.weight,
    style: asset.style,
    mediaType: binary.mediaType,
    byteSize: binary.byteSize,
    sha256: binary.sha256,
    bytes: binary.bytes,
  };
}

function numeric(value: { kind: "literal"; value: number } | { kind: "token"; tokenId: string }, tokens: Map<string, PrototypeToken>) {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || !["number", "spacing", "radius", "fontSize", "lineHeight", "borderWidth", "duration", "fontWeight"].includes(token.type)) {
    throw invalidToken(value.tokenId);
  }
  if (token.type === "fontWeight") return token.value;
  if (token.type === "color" || token.type === "fontFamily" || token.type === "shadow") throw invalidToken(value.tokenId);
  return token.value;
}

function color(value: { kind: "literal"; value: string } | { kind: "token"; tokenId: string }, tokens: Map<string, PrototypeToken>) {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || token.type !== "color") throw invalidToken(value.tokenId);
  return token.value;
}

function stringValue(value: { kind: "literal"; value: string } | { kind: "token"; tokenId: string }, tokens: Map<string, PrototypeToken>) {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  if (!token || token.type !== "fontFamily") throw invalidToken(value.tokenId);
  return token.value;
}

function invalidToken(tokenId: string) {
  return new TerminalExportError("EXPORT_PROTOTYPE_TOKEN_INVALID", `Prototype token ${tokenId} is missing or incompatible`);
}

function alignValue(value: "start" | "center" | "end" | "stretch") {
  return value === "start" ? "flex-start" : value === "end" ? "flex-end" : value;
}

function justifyValue(value: "start" | "center" | "end" | "spaceBetween" | "spaceAround") {
  if (value === "start") return "flex-start";
  if (value === "end") return "flex-end";
  if (value === "spaceBetween") return "space-between";
  if (value === "spaceAround") return "space-around";
  return value;
}

function cssString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function vectorPath(commands: Array<Record<string, number | string>>) {
  return commands.map((command) => {
    switch (command.command) {
      case "moveTo": return `M ${command.x} ${command.y}`;
      case "lineTo": return `L ${command.x} ${command.y}`;
      case "horizontalTo": return `H ${command.x}`;
      case "verticalTo": return `V ${command.y}`;
      case "curveTo": return `C ${command.control1X} ${command.control1Y} ${command.control2X} ${command.control2Y} ${command.x} ${command.y}`;
      case "quadraticTo": return `Q ${command.controlX} ${command.controlY} ${command.x} ${command.y}`;
      case "close": return "Z";
      default: throw new TerminalExportError("EXPORT_VECTOR_COMMAND_INVALID", "Prototype vector contains an unknown command");
    }
  }).join(" ");
}

function renderLucideIcon(iconName: string) {
  const exportName = iconName.split(/[-_\s]+/).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("");
  const component = (LucideIcons as unknown as Record<string, ElementType | undefined>)[exportName];
  if (!component) {
    throw new TerminalExportError(
      "EXPORT_LUCIDE_ICON_UNSUPPORTED",
      `Lucide icon ${iconName} is not available in the pinned icon library`,
    );
  }
  return renderToStaticMarkup(createElement(component, { width: "100%", height: "100%", "aria-hidden": true }));
}

export function artifactCanonicalChecksum(artifact: ExportArtifactSource) {
  const bytes = artifact.content instanceof Uint8Array
    ? artifact.content
    : Buffer.from(canonicalJson(artifact.content), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export const exportHtmlBaseStyles = baseStyles;
