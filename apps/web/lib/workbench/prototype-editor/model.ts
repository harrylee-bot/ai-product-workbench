import {
  prototypeDocumentSchema,
  type PrototypeNumberValue,
  type PrototypeDocument,
  type PrototypeNode,
} from "@workbench/workbench-contracts";
import {
  calculate,
  createOriginMatrix,
  createRotateMatrix,
  invert,
  multiplies,
  multiply,
} from "@scena/matrix";

export const PROTOTYPE_NODE_ID_ATTRIBUTE = "data-prototype-node-id";
export const PROTOTYPE_SELECTABLE_TARGET = `[${PROTOTYPE_NODE_ID_ATTRIBUTE}]`;

export interface PrototypeDomTarget {
  getAttribute(name: string): string | null;
}

export type PrototypeSelection = Readonly<{
  screenId: string;
  nodeIds: readonly string[];
}>;

export type PrototypeRendererTransform = Readonly<{
  translateX: number;
  translateY: number;
  zoom: number;
}>;

export type PrototypePoint = Readonly<{ x: number; y: number }>;
export type PrototypeSize = Readonly<{ width: number; height: number }>;

export type PrototypeTransformSnapshot =
  | Readonly<{
      kind: "move";
      nodeId: string;
      screenId: string;
      x: number;
      y: number;
    }>
  | Readonly<{
      kind: "resize";
      nodeId: string;
      screenId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>
  | Readonly<{
      kind: "rotate";
      nodeId: string;
      screenId: string;
      degrees: number;
      position: PrototypePoint | null;
    }>;

export type PrototypeTransformCommand =
  | Readonly<{
      type: "prototype.node.move";
      nodeId: string;
      screenId: string;
      x: number;
      y: number;
    }>
  | Readonly<{
      type: "prototype.node.resize";
      nodeId: string;
      screenId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>
  | Readonly<{
      type: "prototype.node.rotate";
      nodeId: string;
      screenId: string;
      degrees: number;
      position: PrototypePoint | null;
    }>;

export type PrototypeTransformBatchCommand = Readonly<{
  type: "prototype.nodes.transform.batch";
  screenId: string;
  commands: readonly PrototypeTransformCommand[];
}>;

type LiteralNumber = Readonly<{ kind: "literal"; value: number }>;

export type PrototypeTransformPatch = Readonly<{
  type: "prototype.node.transform.patch";
  nodeId: string;
  screenId: string;
  layout?: Readonly<{
    x?: LiteralNumber;
    y?: LiteralNumber;
    width?: LiteralNumber;
    height?: LiteralNumber;
  }>;
  style?: Readonly<{
    rotation: number;
  }>;
}>;

export type PrototypeTransformPatchBatch = Readonly<{
  type: "prototype.nodes.transform.patch.batch";
  screenId: string;
  patches: readonly PrototypeTransformPatch[];
}>;

export type PrototypeEditorErrorCode =
  | "missing_dom_node_id"
  | "invalid_transform_number"
  | "empty_transform_batch"
  | "duplicate_transform_node"
  | "transform_screen_mismatch"
  | "node_not_found"
  | "node_screen_mismatch"
  | "layout_is_not_absolute"
  | "layout_value_is_token"
  | "group_rotation_root_not_supported";

export type PrototypeEditorResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      code: PrototypeEditorErrorCode;
      nodeId: string;
    }>;

export function prototypeNodeDomProps(nodeId: string): Readonly<Record<typeof PROTOTYPE_NODE_ID_ATTRIBUTE, string>> {
  return { [PROTOTYPE_NODE_ID_ATTRIBUTE]: nodeId };
}

export function prototypeNodeIdFromDomTarget(target: PrototypeDomTarget): string | null {
  const nodeId = target.getAttribute(PROTOTYPE_NODE_ID_ATTRIBUTE)?.trim();
  return nodeId ? nodeId : null;
}

export function selectionFromDomTargets(
  document: PrototypeDocument,
  screenId: string,
  targets: readonly PrototypeDomTarget[],
): PrototypeSelection {
  return selectionFromNodeIds(
    document,
    screenId,
    targets
      .map(prototypeNodeIdFromDomTarget)
      .filter((nodeId): nodeId is string => nodeId !== null),
  );
}

export function selectionFromNodeIds(
  document: PrototypeDocument,
  screenId: string,
  nodeIds: readonly string[],
): PrototypeSelection {
  const requestedIds = new Set(nodeIds);
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const hasSelectedAncestor = (node: PrototypeNode) => {
    let parentId = node.parentId;
    while (parentId !== null) {
      if (requestedIds.has(parentId)) return true;
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
    return false;
  };
  return {
    screenId,
    nodeIds: document.nodes
      .filter((node) => node.screenId === screenId && requestedIds.has(node.id) && !hasSelectedAncestor(node))
      .map((node) => node.id),
  };
}

export function centeredPrototypeRendererTransform(
  hostSize: PrototypeSize,
  documentSize: PrototypeSize,
  zoom: number,
): PrototypeRendererTransform {
  if (![hostSize.width, hostSize.height, documentSize.width, documentSize.height, zoom]
    .every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("renderer dimensions and zoom must be finite positive numbers");
  }
  return {
    translateX: (hostSize.width - documentSize.width * zoom) / 2,
    translateY: (hostSize.height - documentSize.height * zoom) / 2,
    zoom,
  };
}

export function rendererPointToDocument(
  point: PrototypePoint,
  transform: PrototypeRendererTransform,
): PrototypePoint {
  assertRendererTransform(transform);
  return {
    x: normalizeNumber((point.x - transform.translateX) / transform.zoom),
    y: normalizeNumber((point.y - transform.translateY) / transform.zoom),
  };
}

export function rendererSizeToDocument(
  size: PrototypeSize,
  transform: PrototypeRendererTransform,
): PrototypeSize {
  assertRendererTransform(transform);
  return {
    width: normalizeNumber(size.width / transform.zoom),
    height: normalizeNumber(size.height / transform.zoom),
  };
}

export function rendererDeltaToDocument(
  delta: PrototypePoint,
  transform: PrototypeRendererTransform,
): PrototypePoint {
  assertRendererTransform(transform);
  return {
    x: normalizeNumber(delta.x / transform.zoom),
    y: normalizeNumber(delta.y / transform.zoom),
  };
}

type PrototypeAffineTransform = Readonly<{
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}>;

type PrototypeGroupRotationNodeBaseline = Readonly<{
  nodeId: string;
  origin: PrototypePoint;
  world: PrototypeAffineTransform;
  parentWorldInverse: PrototypeAffineTransform;
}>;

export type PrototypeGroupRotationBaseline = Readonly<{
  screenId: string;
  pivot: PrototypePoint;
  nodes: readonly PrototypeGroupRotationNodeBaseline[];
}>;

export function createPrototypeGroupRotationBaseline(
  document: PrototypeDocument,
  screenId: string,
  nodeIds: readonly string[],
): PrototypeEditorResult<PrototypeGroupRotationBaseline> {
  if (nodeIds.length === 0) {
    return { ok: false, code: "empty_transform_batch", nodeId: "" };
  }
  try {
    const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
    const selected = selectionFromNodeIds(document, screenId, nodeIds).nodeIds;
    if (selected.length === 0) {
      return { ok: false, code: "node_not_found", nodeId: nodeIds[0] ?? "" };
    }
    const worldCache = new Map<string, number[]>();
    const worldForNode = (node: PrototypeNode): number[] => {
      const cached = worldCache.get(node.id);
      if (cached) return cached;
      if (node.screenId !== screenId) throw geometryFailure("node_screen_mismatch", node.id);
      if (node.layout.mode !== "absolute") throw geometryFailure("layout_is_not_absolute", node.id);
      const local = prototypeNodeLocalMatrix(document, node);
      const parent = node.parentId === null ? null : nodesById.get(node.parentId);
      if (node.parentId !== null && !parent) throw geometryFailure("node_not_found", node.parentId);
      const world = parent ? multiply(worldForNode(parent), local, 3) : local;
      worldCache.set(node.id, world);
      return world;
    };

    const baselines = selected.map((nodeId): PrototypeGroupRotationNodeBaseline => {
      const node = nodesById.get(nodeId);
      if (!node) throw geometryFailure("node_not_found", nodeId);
      if (node.screenId !== screenId) throw geometryFailure("node_screen_mismatch", nodeId);
      if (node.parentId === null) throw geometryFailure("group_rotation_root_not_supported", nodeId);
      if (node.layout.mode !== "absolute") throw geometryFailure("layout_is_not_absolute", nodeId);
      if (node.layout.x.kind !== "literal" || node.layout.y.kind !== "literal") {
        throw geometryFailure("layout_value_is_token", nodeId);
      }
      const parent = nodesById.get(node.parentId);
      if (!parent) throw geometryFailure("node_not_found", node.parentId);
      const width = prototypeNumber(document, node.layout.width, node.id);
      const height = prototypeNumber(document, node.layout.height, node.id);
      return {
        nodeId,
        origin: {
          x: width * node.style.transformOrigin.x,
          y: height * node.style.transformOrigin.y,
        },
        world: affineTransform(worldForNode(node)),
        parentWorldInverse: affineTransform(invert(worldForNode(parent), 3)),
      };
    });
    const corners = baselines.flatMap((baseline) => {
      const node = nodesById.get(baseline.nodeId)!;
      const width = prototypeNumber(document, node.layout.width, node.id);
      const height = prototypeNumber(document, node.layout.height, node.id);
      const world = scenaMatrix(baseline.world);
      return [
        transformPoint(world, { x: 0, y: 0 }),
        transformPoint(world, { x: width, y: 0 }),
        transformPoint(world, { x: width, y: height }),
        transformPoint(world, { x: 0, y: height }),
      ];
    });
    const left = Math.min(...corners.map((point) => point.x));
    const right = Math.max(...corners.map((point) => point.x));
    const top = Math.min(...corners.map((point) => point.y));
    const bottom = Math.max(...corners.map((point) => point.y));
    return {
      ok: true,
      value: {
        screenId,
        pivot: { x: (left + right) / 2, y: (top + bottom) / 2 },
        nodes: baselines,
      },
    };
  } catch (cause) {
    if (cause instanceof PrototypeGeometryFailure) {
      return { ok: false, code: cause.code, nodeId: cause.nodeId };
    }
    throw cause;
  }
}

export function groupRotationSnapshots(
  baseline: PrototypeGroupRotationBaseline,
  deltaDegrees: number,
): PrototypeEditorResult<readonly PrototypeTransformSnapshot[]> {
  if (!Number.isFinite(deltaDegrees)) {
    return { ok: false, code: "invalid_transform_number", nodeId: baseline.nodes[0]?.nodeId ?? "" };
  }
  const radians = deltaDegrees * Math.PI / 180;
  const rotation = multiplies(
    3,
    createOriginMatrix([baseline.pivot.x, baseline.pivot.y], 3),
    createRotateMatrix(radians, 3),
    createOriginMatrix([-baseline.pivot.x, -baseline.pivot.y], 3),
  );
  const snapshots = baseline.nodes.map((node): PrototypeTransformSnapshot => {
    const nextWorld = multiply(rotation, scenaMatrix(node.world), 3);
    const nextLocal = multiply(scenaMatrix(node.parentWorldInverse), nextWorld, 3);
    const nextOrigin = transformPoint(nextLocal, node.origin);
    return {
      kind: "rotate",
      nodeId: node.nodeId,
      screenId: baseline.screenId,
      degrees: normalizeDegrees(Math.atan2(nextLocal[1]!, nextLocal[0]!) * 180 / Math.PI),
      position: {
        x: normalizeNumber(nextOrigin.x - node.origin.x),
        y: normalizeNumber(nextOrigin.y - node.origin.y),
      },
    };
  });
  return { ok: true, value: snapshots };
}

export function commandFromTransformSnapshot(
  snapshot: PrototypeTransformSnapshot,
): PrototypeEditorResult<PrototypeTransformCommand> {
  if (!snapshot.nodeId.trim()) {
    return { ok: false, code: "missing_dom_node_id", nodeId: snapshot.nodeId };
  }
  const numbers = snapshot.kind === "resize"
    ? [snapshot.x, snapshot.y, snapshot.width, snapshot.height]
    : snapshot.kind === "move"
      ? [snapshot.x, snapshot.y]
      : [
          snapshot.degrees,
          ...(snapshot.position === null ? [] : [snapshot.position.x, snapshot.position.y]),
        ];
  if (numbers.some((value) => !Number.isFinite(value))) {
    return { ok: false, code: "invalid_transform_number", nodeId: snapshot.nodeId };
  }

  if (snapshot.kind === "move") {
    return {
      ok: true,
      value: {
        type: "prototype.node.move",
        nodeId: snapshot.nodeId,
        screenId: snapshot.screenId,
        x: normalizeNumber(snapshot.x),
        y: normalizeNumber(snapshot.y),
      },
    };
  }
  if (snapshot.kind === "resize") {
    const width = normalizeNumber(snapshot.width);
    const height = normalizeNumber(snapshot.height);
    if (width <= 0 || height <= 0) {
      return { ok: false, code: "invalid_transform_number", nodeId: snapshot.nodeId };
    }
    return {
      ok: true,
      value: {
        type: "prototype.node.resize",
        nodeId: snapshot.nodeId,
        screenId: snapshot.screenId,
        x: normalizeNumber(snapshot.x),
        y: normalizeNumber(snapshot.y),
        width,
        height,
      },
    };
  }
  return {
    ok: true,
    value: {
      type: "prototype.node.rotate",
      nodeId: snapshot.nodeId,
      screenId: snapshot.screenId,
      degrees: normalizeDegrees(snapshot.degrees),
      position: snapshot.position === null
        ? null
        : {
            x: normalizeNumber(snapshot.position.x),
            y: normalizeNumber(snapshot.position.y),
          },
    },
  };
}

export function commandBatchFromTransformSnapshots(
  snapshots: readonly PrototypeTransformSnapshot[],
): PrototypeEditorResult<PrototypeTransformBatchCommand> {
  if (snapshots.length === 0) {
    return { ok: false, code: "empty_transform_batch", nodeId: "" };
  }
  const commands: PrototypeTransformCommand[] = [];
  const nodeIds = new Set<string>();
  const screenId = snapshots[0].screenId;
  for (const snapshot of snapshots) {
    if (snapshot.screenId !== screenId) {
      return { ok: false, code: "transform_screen_mismatch", nodeId: snapshot.nodeId };
    }
    if (nodeIds.has(snapshot.nodeId)) {
      return { ok: false, code: "duplicate_transform_node", nodeId: snapshot.nodeId };
    }
    const result = commandFromTransformSnapshot(snapshot);
    if (!result.ok) return result;
    nodeIds.add(snapshot.nodeId);
    commands.push(result.value);
  }
  return {
    ok: true,
    value: {
      type: "prototype.nodes.transform.batch",
      screenId,
      commands,
    },
  };
}

export function patchFromTransformCommand(
  document: PrototypeDocument,
  command: PrototypeTransformCommand,
): PrototypeEditorResult<PrototypeTransformPatch> {
  const node = document.nodes.find((candidate) => candidate.id === command.nodeId);
  if (!node) return { ok: false, code: "node_not_found", nodeId: command.nodeId };
  const validation = validateEditableNode(node, command);
  if (validation) return validation;
  if (command.type === "prototype.node.rotate") {
    if (command.position !== null) {
      if (node.layout.x.kind !== "literal" || node.layout.y.kind !== "literal") {
        return { ok: false, code: "layout_value_is_token", nodeId: command.nodeId };
      }
    }
    return {
      ok: true,
      value: {
        type: "prototype.node.transform.patch",
        nodeId: command.nodeId,
        screenId: command.screenId,
        ...(command.position === null ? {} : {
          layout: {
            x: literal(command.position.x),
            y: literal(command.position.y),
          },
        }),
        style: { rotation: command.degrees },
      },
    };
  }

  const updatedKeys = command.type === "prototype.node.move"
    ? ["x", "y"] as const
    : ["x", "y", "width", "height"] as const;
  if (updatedKeys.some((key) => node.layout[key].kind !== "literal")) {
    return { ok: false, code: "layout_value_is_token", nodeId: command.nodeId };
  }

  return {
    ok: true,
    value: {
      type: "prototype.node.transform.patch",
      nodeId: command.nodeId,
      screenId: command.screenId,
      layout: command.type === "prototype.node.move"
        ? { x: literal(command.x), y: literal(command.y) }
        : {
            x: literal(command.x),
            y: literal(command.y),
            width: literal(command.width),
            height: literal(command.height),
          },
    },
  };
}

export function patchBatchFromTransformCommand(
  document: PrototypeDocument,
  batch: PrototypeTransformBatchCommand,
): PrototypeEditorResult<PrototypeTransformPatchBatch> {
  const patches: PrototypeTransformPatch[] = [];
  for (const command of batch.commands) {
    const result = patchFromTransformCommand(document, command);
    if (!result.ok) return result;
    patches.push(result.value);
  }
  return {
    ok: true,
    value: {
      type: "prototype.nodes.transform.patch.batch",
      screenId: batch.screenId,
      patches,
    },
  };
}

export function applyPrototypeTransformPatch(
  document: PrototypeDocument,
  patch: PrototypeTransformPatch,
): PrototypeDocument {
  const node = document.nodes.find((candidate) => candidate.id === patch.nodeId);
  if (!node) throw new RangeError(`Prototype transform patch node not found: ${patch.nodeId}`);
  if (node.screenId !== patch.screenId) {
    throw new RangeError(`Prototype transform patch screen mismatch: ${patch.nodeId}`);
  }
  const candidate = {
    ...document,
    revision: document.revision + 1,
    nodes: document.nodes.map((node) => node.id === patch.nodeId
      ? {
          ...node,
          ...(patch.layout ? { layout: { ...node.layout, ...patch.layout } } : {}),
          ...(patch.style ? { style: { ...node.style, ...patch.style } } : {}),
        }
      : node),
  };
  return prototypeDocumentSchema.parse(candidate);
}

export function applyPrototypeTransformPatchBatch(
  document: PrototypeDocument,
  batch: PrototypeTransformPatchBatch,
): PrototypeDocument {
  if (batch.patches.length === 0) throw new RangeError("Prototype transform patch batch must not be empty");
  if (new Set(batch.patches.map((patch) => patch.nodeId)).size !== batch.patches.length) {
    throw new RangeError("Prototype transform patch batch contains duplicate nodes");
  }
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  for (const patch of batch.patches) {
    const node = nodesById.get(patch.nodeId);
    if (!node) throw new RangeError(`Prototype transform patch node not found: ${patch.nodeId}`);
    if (patch.screenId !== batch.screenId || node.screenId !== batch.screenId) {
      throw new RangeError(`Prototype transform patch screen mismatch: ${patch.nodeId}`);
    }
  }
  const patches = new Map(batch.patches.map((patch) => [patch.nodeId, patch]));
  const candidate = {
    ...document,
    revision: document.revision + 1,
    nodes: document.nodes.map((node) => {
      const patch = patches.get(node.id);
      return patch ? {
        ...node,
        ...(patch.layout ? { layout: { ...node.layout, ...patch.layout } } : {}),
        ...(patch.style ? { style: { ...node.style, ...patch.style } } : {}),
      } : node;
    }),
  };
  return prototypeDocumentSchema.parse(candidate);
}

export interface PrototypeTransformGestureBuffer {
  preview(snapshots: readonly PrototypeTransformSnapshot[]): PrototypeEditorResult<PrototypeTransformBatchCommand>;
  commit(): PrototypeEditorResult<PrototypeTransformBatchCommand> | null;
  cancel(): void;
}

export function createPrototypeTransformGestureBuffer(): PrototypeTransformGestureBuffer {
  let pending: PrototypeEditorResult<PrototypeTransformBatchCommand> | null = null;
  return {
    preview(snapshots) {
      pending = commandBatchFromTransformSnapshots(snapshots);
      return pending;
    },
    commit() {
      const result = pending;
      pending = null;
      return result;
    },
    cancel() {
      pending = null;
    },
  };
}

function validateEditableNode(
  node: PrototypeNode,
  command: PrototypeTransformCommand,
): Extract<PrototypeEditorResult<never>, { ok: false }> | null {
  if (node.screenId !== command.screenId) {
    return { ok: false, code: "node_screen_mismatch", nodeId: command.nodeId };
  }
  const changesLayout = command.type !== "prototype.node.rotate" || command.position !== null;
  if (changesLayout && node.layout.mode !== "absolute") {
    return { ok: false, code: "layout_is_not_absolute", nodeId: command.nodeId };
  }
  return null;
}

function literal(value: number): LiteralNumber {
  return { kind: "literal", value };
}

class PrototypeGeometryFailure extends Error {
  constructor(
    readonly code: PrototypeEditorErrorCode,
    readonly nodeId: string,
  ) {
    super(code);
  }
}

function geometryFailure(code: PrototypeEditorErrorCode, nodeId: string): PrototypeGeometryFailure {
  return new PrototypeGeometryFailure(code, nodeId);
}

function prototypeNodeLocalMatrix(document: PrototypeDocument, node: PrototypeNode): number[] {
  const x = prototypeNumber(document, node.layout.x, node.id);
  const y = prototypeNumber(document, node.layout.y, node.id);
  const width = prototypeNumber(document, node.layout.width, node.id);
  const height = prototypeNumber(document, node.layout.height, node.id);
  const originX = width * node.style.transformOrigin.x;
  const originY = height * node.style.transformOrigin.y;
  return multiplies(
    3,
    createOriginMatrix([x, y], 3),
    createOriginMatrix([originX, originY], 3),
    createRotateMatrix(node.style.rotation * Math.PI / 180, 3),
    createOriginMatrix([-originX, -originY], 3),
  );
}

function prototypeNumber(
  document: PrototypeDocument,
  value: PrototypeNumberValue,
  nodeId: string,
): number {
  if (value.kind === "literal") return value.value;
  const token = document.tokens.find((candidate) => candidate.id === value.tokenId);
  if (!token || typeof token.value !== "number" || !Number.isFinite(token.value)) {
    throw geometryFailure("invalid_transform_number", nodeId);
  }
  return token.value;
}

function affineTransform(matrix: readonly number[]): PrototypeAffineTransform {
  return {
    a: matrix[0]!,
    b: matrix[1]!,
    c: matrix[3]!,
    d: matrix[4]!,
    e: matrix[6]!,
    f: matrix[7]!,
  };
}

function scenaMatrix(matrix: PrototypeAffineTransform): number[] {
  return [
    matrix.a, matrix.b, 0,
    matrix.c, matrix.d, 0,
    matrix.e, matrix.f, 1,
  ];
}

function transformPoint(matrix: readonly number[], point: PrototypePoint): PrototypePoint {
  const result = calculate([...matrix], [point.x, point.y, 1], 3);
  return { x: result[0]!, y: result[1]! };
}

function assertRendererTransform(transform: PrototypeRendererTransform): void {
  if (!Number.isFinite(transform.translateX)
    || !Number.isFinite(transform.translateY)
    || !Number.isFinite(transform.zoom)
    || transform.zoom <= 0) {
    throw new RangeError("renderer transform must contain finite translation and positive zoom");
  }
}

function normalizeNumber(value: number): number {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeDegrees(value: number): number {
  const normalized = ((value % 360) + 540) % 360 - 180;
  return normalizeNumber(normalized);
}
