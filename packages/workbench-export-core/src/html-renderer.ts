import { createHash } from "node:crypto";
import {
  canonicalJson,
  designSystemDocumentSchema,
  materializeRuntimeDesignStyleSnapshot,
  orderBoardNodesByHierarchy,
  prdChannelLabels,
  prdDocumentSchema,
  prdSafetyBaselineItems,
  prototypeDocumentSchema,
  resolveExportBoardNodeSelection,
  type DesignSystemDocument,
  type ExportSelection,
  type JsonValue,
  type ProjectReleaseBoardSnapshot,
  type PrototypeAsset,
  type PrototypeDocument,
  type PrototypeNode,
  type PrototypeToken,
  type PrdBlock,
  type PrdDocument,
  type PrdInline,
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

const baseStyles = String.raw`*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#f4f5f7;color:#17191d;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,textarea,select{font:inherit}.wb-export{min-height:100vh}.wb-export__header{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:56px;padding:10px 20px;background:#fff;border-bottom:1px solid #dfe2e7}.wb-export__title{margin:0;font-size:16px;line-height:1.4;font-weight:650}.wb-export__meta{font-size:12px;color:#69707d}.wb-export__content{padding:20px}.wb-board{position:relative;min-width:720px;min-height:360px;margin:0 0 24px;background:#e9ebef;background-image:linear-gradient(#d9dce2 1px,transparent 1px),linear-gradient(90deg,#d9dce2 1px,transparent 1px);background-size:24px 24px;border:1px solid #ced2d9;overflow:auto}.wb-board__node{position:absolute;display:flex;flex-direction:column;justify-content:center;min-width:120px;min-height:72px;padding:12px;background:#fff;border:1px solid #bcc2cc;box-shadow:0 2px 8px rgba(18,22,30,.08)}.wb-board__node--frame{justify-content:flex-start;min-width:0;min-height:0;padding:0;background:transparent;box-shadow:none}.wb-board__node--frame .wb-board__label{position:absolute;left:0;top:-20px;margin:0}.wb-board__node--drawing{display:block;min-width:0;min-height:0;padding:0;background:transparent;border:0;box-shadow:none}.wb-board__drawing{display:block;width:100%;height:100%;overflow:visible}.wb-board__kind{font-size:11px;color:#69707d;text-transform:uppercase}.wb-board__label{margin-top:4px;font-size:13px;font-weight:600}.wb-artifacts{display:grid;gap:20px}.wb-artifact{min-width:0;background:#fff;border:1px solid #d5d9e0}.wb-artifact__header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid #e1e4e9}.wb-artifact__title{margin:0;font-size:14px;font-weight:650}.wb-artifact__kind{font-size:11px;color:#69707d}.wb-artifact__body{padding:14px;overflow:auto}.wb-prototype__tabs{display:flex;gap:6px;margin-bottom:12px;overflow:auto}.wb-prototype__tab{height:32px;padding:0 12px;border:1px solid #cbd0d8;background:#fff;color:#3b414b;cursor:pointer}.wb-prototype__tab[aria-selected="true"]{background:#17191d;color:#fff;border-color:#17191d}.wb-prototype__stage{display:flex;justify-content:flex-start;overflow:auto;padding:16px;background:#e8eaee}.wb-screen{position:relative;flex:0 0 auto;background:#fff;box-shadow:0 8px 24px rgba(18,22,30,.14);overflow:hidden}.wb-node[hidden],.wb-screen[hidden]{display:none!important}.wb-node{letter-spacing:0}.wb-design-system{display:grid;gap:22px}.wb-design-system h3{margin:0 0 10px;font-size:13px}.wb-design-system__tokens,.wb-design-system__assets,.wb-design-system__items{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}.wb-design-system__token,.wb-design-system__asset,.wb-design-system__item{min-width:0;padding:10px;border:1px solid #dfe2e7;background:#fafbfc}.wb-design-system__swatch{display:block;width:100%;height:44px;margin-bottom:8px;border:1px solid rgba(0,0,0,.12)}.wb-design-system__label{display:block;font-size:12px;font-weight:650;overflow-wrap:anywhere}.wb-design-system__value{display:block;margin-top:3px;color:#69707d;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}.wb-design-system__image{display:block;width:100%;height:120px;margin-bottom:8px;object-fit:contain;background:#eef0f3}.wb-design-system__font-preview{display:flex;align-items:center;width:100%;height:72px;margin-bottom:8px;padding:8px;background:#eef0f3;font-size:28px;line-height:1;overflow:hidden}.wb-design-system__copy{margin:4px 0 0;color:#565d68;font-size:12px;line-height:1.5}.wb-json{max-height:70vh;margin:0;overflow:auto;padding:16px;background:#15171b;color:#e8eaed;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}.wb-image{display:block;max-width:100%;height:auto}.wb-document{white-space:pre-wrap;line-height:1.6}.wb-prd{max-width:1100px;margin:0 auto;background:#fff;color:#1e2935;padding:48px 64px;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;line-height:1.7}.wb-prd__cover{min-height:320px;display:flex;flex-direction:column;justify-content:center;border-bottom:1px solid #cbd5e1;margin-bottom:36px}.wb-prd__cover h1{font-size:32px;margin:8px 0;color:#124b7a}.wb-prd h2{font-size:24px;color:#124b7a;border-bottom:2px solid #d8e4ef;padding-bottom:8px;margin:38px 0 16px}.wb-prd h3{font-size:18px;color:#1c628f;margin:24px 0 8px}.wb-prd__muted{color:#64748b;font-size:13px}.wb-prd__toc,.wb-prd__history,.wb-prd__table,.wb-prd__safety{width:100%;border-collapse:collapse;margin:12px 0 22px}.wb-prd__toc td,.wb-prd__history th,.wb-prd__history td,.wb-prd__table th,.wb-prd__table td,.wb-prd__safety th,.wb-prd__safety td{border:1px solid #cbd5e1;padding:8px;text-align:left;vertical-align:top}.wb-prd__history th,.wb-prd__table th,.wb-prd__safety th{background:#edf4f9}.wb-prd__block{margin:10px 0}.wb-prd__card{border:1px solid #d8e1ea;border-left:4px solid #2b6f9f;padding:12px 16px;margin:12px 0}.wb-prd__diagram{border:1px solid #cbd5e1;background:#f8fafc;padding:14px;margin:14px 0}.wb-prd__diagram-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.wb-prd__diagram-node{border:1px solid #6b8ca8;border-radius:4px;background:#fff;padding:8px;font-size:13px}.wb-prd__assumptions{border-left:4px solid #d97706;background:#fff7ed;padding:12px 16px}.wb-json{max-height:70vh;margin:0;overflow:auto;padding:16px;background:#15171b;color:#e8eaed;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}.wb-image{display:block;max-width:100%;height:auto}.wb-document{white-space:pre-wrap;line-height:1.6}.wb-empty{padding:40px;text-align:center;color:#69707d}@media(max-width:700px){.wb-export__content{padding:10px}.wb-export__header{padding:8px 12px}.wb-board{min-width:640px}.wb-artifact__body{padding:8px}.wb-prd{padding:28px 18px}.wb-prd__cover{min-height:220px}.wb-design-system__tokens,.wb-design-system__assets,.wb-design-system__items{grid-template-columns:1fr}}`;

export function renderExportHtml(request: ExportBuildRequest): RenderedHtml {
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
    ))
    .join("");
  const includeBoard = request.selection.kind !== "artifact";
  const boardMarkup = includeBoard
    ? renderBoard(request, selectExportBoardSnapshot(request.source.boardSnapshot, request.selection))
    : "";
  const title = selected.length === 1
    ? `${selected[0]!.title} v${selected[0]!.version}`
    : `Project release v${request.source.releaseVersion}`;
  const styles = `${baseStyles}\n${fontFaces.join("\n")}`;
  const runtimeData = { protocol: "workbench.export-runtime.v1", prototypes: runtimePrototypes } satisfies JsonValue;
  const bodyMarkup = `<main class="wb-export"><header class="wb-export__header"><h1 class="wb-export__title">${escapeHtml(title)}</h1><div class="wb-export__meta">Release ${request.source.releaseVersion} · ${selected.length} artifact${selected.length === 1 ? "" : "s"}</div></header><div class="wb-export__content">${boardMarkup}<div class="wb-artifacts">${artifactMarkup || '<div class="wb-empty">This selection contains no exportable artifacts.</div>'}</div></div></main>`;
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><div id="workbench-export-root">${bodyMarkup}</div><script id="workbench-export-data" type="application/json">${safeScriptJson(runtimeData)}</script><script>${browserRuntimeSource}</script></body></html>`;
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
) {
  if (screenId !== undefined && artifact.kind !== "prototype") {
    throw new TerminalExportError(
      "EXPORT_SELECTION_SCREEN_KIND_INVALID",
      "screenId is supported only for Prototype Artifact selections",
    );
  }
  const body = artifact.kind === "prototype"
    ? renderPrototypeArtifact(artifact, runtimePrototypes, fontFaces, fontAssets, screenId)
      : artifact.kind === "design_system"
        ? renderDesignSystemArtifact(artifact, fontFaces, fontAssets)
    : artifact.kind === "prd"
      ? renderPrdArtifact(artifact)
    : renderGenericArtifact(artifact);
  return `<article class="wb-artifact" data-artifact-id="${escapeHtml(artifact.artifactId)}" data-artifact-version-id="${escapeHtml(artifact.artifactVersionId)}"><header class="wb-artifact__header"><h2 class="wb-artifact__title">${escapeHtml(artifact.title)}</h2><span class="wb-artifact__kind">${escapeHtml(artifact.kind)} · v${artifact.version}</span></header><div class="wb-artifact__body">${body}</div></article>`;
}

function renderPrdArtifact(artifact: ExportArtifactSource) {
  const parsed = prdDocumentSchema.safeParse(artifact.content);
  if (!parsed.success) {
    throw new TerminalExportError(
      "EXPORT_PRD_CONTENT_INVALID",
      "The selected PRD artifact does not conform to the PRD document contract",
    );
  }
  return renderPrdDocument(parsed.data);
}

function renderPrdDocument(document: PrdDocument) {
  if (document.protocol === "workbench.prd.v2") {
    const introduction = document.sections.introduction;
    const requirements = document.sections.businessRequirements;
    return `<div class="wb-prd">
      <section class="wb-prd__cover">
        <div class="wb-prd__muted">需求说明书 · v${document.revision.number}</div>
        <h1>${escapeHtml(document.cover.title)}</h1>
        <p>${escapeHtml(document.revision.summary)}</p>
        <p class="wb-prd__muted">变更时间：${escapeHtml(document.revision.changedAt)}</p>
      </section>
      ${renderPrdVersionHistory(document.versionHistory)}
      ${renderPrdToc(document.tableOfContents.entries)}
      <h2>${escapeHtml(introduction.title)}</h2>
      ${renderPrdSection(introduction.background)}
      ${renderPrdSection(introduction.scope)}
      ${renderPrdSection(introduction.usageScenarios)}
      ${renderPrdChannelTable(introduction.usageScenarios.channelTable)}
      <h2>${escapeHtml(requirements.title)}</h2>
      <div class="wb-prd__block">${renderPrdInlinesHtml(requirements.summary)}</div>
      ${renderPrdSection(requirements.pageLinks)}
      ${renderPrdSection(requirements.coreRules)}
      ${renderPrdSection(requirements.flowAndPages)}
      ${requirements.flowAndPages.diagrams.map(renderPrdDiagram).join("")}
      ${renderPrdSection(requirements.acceptanceCriteria)}
      ${requirements.additionalSections.map((section) => renderPrdSection(section)).join("")}
      <h2>${escapeHtml(document.sections.degradation.title)}</h2>
      <div class="wb-prd__block">${renderPrdInlinesHtml(document.sections.degradation.content)}</div>
      <h2>${escapeHtml(document.sections.safetyBaseline.title)}</h2>
      <p>${escapeHtml(document.sections.safetyBaseline.intro)}</p>
      ${renderPrdSafetyTable(document.sections.safetyBaseline.rows)}
      ${renderPrdAssumptions(document.assumptions)}
    </div>`;
  }

  return `<div class="wb-prd">
    <section class="wb-prd__cover">
      <div class="wb-prd__muted">PRD · v${document.revision.number}</div>
      <h1>${escapeHtml(document.title)}</h1>
      <p>${escapeHtml(document.revision.summary)}</p>
    </section>
    ${document.sections && Object.entries(document.sections).map(([key, section]) => (
      `<h2>${escapeHtml(section.title || key)}</h2>${renderPrdSection(section)}`
    )).join("")}
  </div>`;
}

function renderPrdVersionHistory(entries: ReadonlyArray<{ status: string; author: string; participants: readonly string[]; startDate: string; endDate: string; notes: string }>) {
  return `<h2>版本历史</h2><table class="wb-prd__history"><thead><tr><th>状态</th><th>作者</th><th>参与人</th><th>日期</th><th>变更说明</th></tr></thead><tbody>${
    entries.map((entry) => `<tr><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.author)}</td><td>${entry.participants.map(escapeHtml).join("、")}</td><td>${escapeHtml(entry.startDate)} 至 ${escapeHtml(entry.endDate)}</td><td>${escapeHtml(entry.notes)}</td></tr>`).join("")
  }</tbody></table>`;
}

function renderPrdToc(entries: readonly string[]) {
  return `<h2>目 录</h2><table class="wb-prd__toc"><tbody>${entries.map((entry) => `<tr><td>${escapeHtml(entry)}</td></tr>`).join("")}</tbody></table>`;
}

function renderPrdSection(section: { title: string; blocks: readonly PrdBlock[] }) {
  return `<section class="wb-prd__section">${section.blocks.map(renderPrdBlock).join("")}</section>`;
}

function renderPrdBlock(block: PrdBlock): string {
  switch (block.type) {
    case "paragraph":
      return `<p class="wb-prd__block">${renderPrdInlinesHtml(block.content)}</p>`;
    case "heading":
      return `<h${block.level}>${renderPrdInlinesHtml(block.content)}</h${block.level}>`;
    case "bulletList":
    case "orderedList":
      return `<${block.type === "bulletList" ? "ul" : "ol"}>${block.items.map((item) => `<li>${renderPrdInlinesHtml(item.content)}</li>`).join("")}</${block.type === "bulletList" ? "ul" : "ol"}>`;
    case "table":
      return `<table class="wb-prd__table"><thead><tr>${block.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.cells.map((cell) => `<td>${renderPrdInlinesHtml(cell.content)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "callout":
      return `<div class="wb-prd__card"><strong>${block.title ? escapeHtml(block.title) : block.tone}</strong><div>${renderPrdInlinesHtml(block.content)}</div></div>`;
    case "goal":
      return `<div class="wb-prd__card"><strong>${escapeHtml(block.title)}</strong><p>${renderPrdInlinesHtml(block.description)}</p><p><b>成功指标：</b>${escapeHtml(block.successMetric)} <b>优先级：</b>${escapeHtml(block.priority)}</p></div>`;
    case "persona":
      return `<div class="wb-prd__card"><strong>${escapeHtml(block.name)}</strong><p>${renderPrdInlinesHtml(block.description)}</p><p><b>需求：</b>${block.needs.map(escapeHtml).join("；")}</p><p><b>痛点：</b>${block.painPoints.map(escapeHtml).join("；")}</p></div>`;
    case "requirement":
      return `<div class="wb-prd__card"><strong>${escapeHtml(block.title)}</strong><p>${renderPrdInlinesHtml(block.description)}</p><p><b>优先级：</b>${escapeHtml(block.priority)} <b>目标：</b>${block.goalIds.map(escapeHtml).join("、")}</p></div>`;
    case "acceptanceCriterion":
      return `<div class="wb-prd__card"><div><b>前置条件：</b>${renderPrdInlinesHtml(block.given)}</div><div><b>触发操作：</b>${renderPrdInlinesHtml(block.when)}</div><div><b>预期结果：</b>${renderPrdInlinesHtml(block.then)}</div></div>`;
    case "flow":
      return `<div class="wb-prd__card"><strong>${escapeHtml(block.title)}</strong><p><b>角色：</b>${escapeHtml(block.actor)} <b>触发：</b>${escapeHtml(block.trigger)}</p><ol>${block.steps.map((step) => `<li>${escapeHtml(step.text)}</li>`).join("")}</ol><p><b>结果：</b>${escapeHtml(block.outcome)}</p></div>`;
    case "risk":
      return `<div class="wb-prd__card"><p>${renderPrdInlinesHtml(block.description)}</p><p><b>可能性：</b>${escapeHtml(block.likelihood)} <b>影响：</b>${escapeHtml(block.impact)}</p><p><b>缓解：</b>${renderPrdInlinesHtml(block.mitigation)}</p></div>`;
  }
}

function renderPrdInlinesHtml(inlines: readonly PrdInline[]) {
  return inlines.map((inline) => {
    if (inline.type === "link") return `<a href="${escapeHtml(inline.href)}">${escapeHtml(inline.text)}</a>`;
    if (inline.type === "citation") return `<sup>[${escapeHtml(inline.label ?? inline.citationId)}]</sup>`;
    if (inline.type === "reference") return `<span>[${escapeHtml(inline.label ?? inline.targetId)}]</span>`;
    let text = escapeHtml(inline.text);
    for (const mark of inline.marks) {
      if (mark === "strong") text = `<strong>${text}</strong>`;
      if (mark === "emphasis") text = `<em>${text}</em>`;
      if (mark === "code") text = `<code>${text}</code>`;
      if (mark === "strikethrough") text = `<s>${text}</s>`;
    }
    return text;
  }).join("");
}

function renderPrdChannelTable(table: { title: string; rows: ReadonlyArray<{ sequence: number; channel: keyof typeof prdChannelLabels; enabled: boolean }> }) {
  return `<h3>${escapeHtml(table.title)}</h3><table class="wb-prd__table"><thead><tr><th>序号</th><th>渠道</th><th>是否启用</th></tr></thead><tbody>${table.rows.map((row) => `<tr><td>${row.sequence}</td><td>${escapeHtml(prdChannelLabels[row.channel])}</td><td>${row.enabled ? "是" : "否"}</td></tr>`).join("")}</tbody></table>`;
}

function renderPrdDiagram(diagram: { title: string; description: string; nodes: ReadonlyArray<{ id: string; label: string; group: string | null }>; edges: ReadonlyArray<{ from: string; to: string; label: string | null }> }) {
  return `<div class="wb-prd__diagram"><h3>${escapeHtml(diagram.title)}</h3><p>${escapeHtml(diagram.description)}</p><div class="wb-prd__diagram-grid">${diagram.nodes.map((node) => `<div class="wb-prd__diagram-node"><strong>${escapeHtml(node.label)}</strong>${node.group ? `<div class="wb-prd__muted">${escapeHtml(node.group)}</div>` : ""}</div>`).join("")}</div><ul>${diagram.edges.map((edge) => `<li>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}${edge.label ? `：${escapeHtml(edge.label)}` : ""}</li>`).join("")}</ul></div>`;
}

function renderPrdSafetyTable(rows: ReadonlyArray<{ sequence: number; applicability: string; remarks: string | null }>) {
  return `<table class="wb-prd__safety"><thead><tr><th>序号</th><th>安全基线项</th><th>是否涉及</th><th>备注</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.sequence}</td><td>${escapeHtml(prdSafetyBaselineItems[row.sequence - 1]?.requirement ?? "")}</td><td>${escapeHtml(row.applicability)}</td><td>${escapeHtml(row.remarks ?? "")}</td></tr>`).join("")}</tbody></table>`;
}

function renderPrdAssumptions(assumptions: ReadonlyArray<{ statement: string; status: string; impact: string; owner: string | null }>) {
  if (assumptions.length === 0) return "";
  return `<section class="wb-prd__assumptions"><h3>假设与未决事项</h3><ul>${assumptions.map((item) => `<li>${escapeHtml(item.statement)}（${escapeHtml(item.status)}，影响：${escapeHtml(item.impact)}${item.owner ? `，负责人：${escapeHtml(item.owner)}` : ""}）</li>`).join("")}</ul></section>`;
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

  for (const asset of document.assets) {
    if (asset.kind !== "font") continue;
    const blob = requireAssetBlob(asset, blobs);
    fontFaces.push(`@font-face{font-family:${cssString(asset.family)};src:url(${cssString(dataUri(blob.mediaType, blob.bytes))});font-style:${asset.style};font-weight:${asset.weight};font-display:swap}`);
    fontAssets.push(renderedFontAsset(artifact.artifactVersionId, asset, blob));
  }

  const screenMarkup = screens.map((screen, index) => {
    const root = nodes.get(screen.rootNodeId);
    if (!root) throw new TerminalExportError("EXPORT_PROTOTYPE_ROOT_MISSING", `Screen ${screen.id} has no root node`);
    return `<section class="wb-screen" data-wb-screen="${escapeHtml(screen.id)}" style="width:${screen.viewport.width}px;height:${screen.viewport.height}px"${index === 0 ? "" : " hidden"}>${renderNode(root, {
      nodes,
      tokens,
      assets,
      blobs,
      bindings: new Map(document.bindings.map((binding) => [binding.id, binding])),
      variables: new Map(document.variables.map((variable) => [variable.path, variable.initialValue])),
    })}</section>`;
  }).join("");
  const tabs = screens.map((screen, index) => `<button class="wb-prototype__tab" type="button" data-wb-screen-target="${escapeHtml(screen.id)}" role="tab" aria-selected="${index === 0}">${escapeHtml(screen.name)}</button>`).join("");
  runtimePrototypes.push(runtimeModel(prefix, document, tokens, assets, blobs, screens));
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
    ...styleDeclarations(style, tokens),
  ];
  return declarations.join(";");
}

function styleDeclarations(style: PrototypeStyle, tokens: Map<string, PrototypeToken>) {
  const shadows = style.shadowTokenIds.map((id) => {
    const token = tokens.get(id);
    if (!token || token.type !== "shadow") throw invalidToken(id);
    return `${token.value.offsetX}px ${token.value.offsetY}px ${token.value.blur}px ${token.value.spread}px ${token.value.color}`;
  });
  const declarations = [
    `opacity:${style.opacity}`,
    `transform:rotate(${style.rotation}deg)`,
    "transform-box:border-box",
    `transform-origin:${style.transformOrigin.x * 100}% ${style.transformOrigin.y * 100}%`,
    ...(style.fill ? [`background-color:${color(style.fill, tokens)}`] : []),
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

function runtimeModel(
  id: string,
  document: PrototypeDocument,
  tokens: Map<string, PrototypeToken>,
  assets: Map<string, PrototypeAsset>,
  blobs: Map<string, ExportBinaryAsset>,
  screens: PrototypeDocument["screens"],
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
    initialScreenId: screens[0]!.id,
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
