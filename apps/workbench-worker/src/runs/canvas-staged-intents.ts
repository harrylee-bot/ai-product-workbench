import { createHash } from "node:crypto";
import {
  canvasAgentToolInputSchemas,
  canonicalJson,
  prototypeDocumentSchema,
  type CanvasScreenReference,
  type PrototypeDocument,
  type RuntimeArtifactDraft,
  type RuntimeResult,
  type StartRunRequest,
} from "@workbench/workbench-contracts";

export type CanvasMutationInvocationRow = {
  id: string;
  sequence: number;
  toolCallId: string;
  toolName: string;
  requestHash: string;
  request: unknown;
  satisfiesRunTarget: boolean;
  targetBoardNodeId: string | null;
  targetArtifactId: string | null;
  targetArtifactVersionId: string | null;
  targetScreenId: string | null;
};

type CanvasIntentBase = {
  id: string;
  sequence: number;
  toolCallId: string;
  requestHash: string;
  target: CanvasScreenReference;
};

export type CanvasDirectIntent =
  | CanvasIntentBase & { toolName: "rename_screen"; title: string }
  | CanvasIntentBase & { toolName: "duplicate_screen" };

export type CanvasPublicationIntents =
  | { mode: "none" }
  | { mode: "quick_edit"; invocationIds: string[]; target: CanvasScreenReference }
  | { mode: "direct"; intents: CanvasDirectIntent[] };

export type CanvasDuplicateEffect = {
  invocationId: string;
  nodeKey: string;
  screen: PrototypeDocument["screens"][number];
};

export type AppliedCanvasDirectIntents = {
  document: PrototypeDocument;
  duplicateEffects: CanvasDuplicateEffect[];
};

export type CanvasDirectIntentRuntimePlan = AppliedCanvasDirectIntents & {
  intents: CanvasDirectIntent[];
  artifactIndex: number;
  originalDraft: RuntimeArtifactDraft;
  effectiveDraft: RuntimeArtifactDraft;
  effectiveResult: RuntimeResult;
};

export function classifyCanvasPublicationIntents(
  rows: readonly CanvasMutationInvocationRow[],
): CanvasPublicationIntents {
  if (rows.length === 0) return { mode: "none" };
  const ordered = [...rows].sort(compareInvocations);
  if (ordered.some((row) => !Number.isSafeInteger(row.sequence) || row.sequence < 1)) {
    throw new Error("CANVAS_MUTATION_SEQUENCE_INVALID");
  }
  if (new Set(ordered.map((row) => row.sequence)).size !== ordered.length) {
    throw new Error("CANVAS_MUTATION_SEQUENCE_DUPLICATED");
  }
  const quickEditIds: string[] = [];
  const quickEditTargets: CanvasScreenReference[] = [];
  const directIntents: CanvasDirectIntent[] = [];

  for (const row of ordered) {
    if (!row.satisfiesRunTarget) {
      throw new Error(row.toolName === "quick_edit"
        ? "CANVAS_QUICK_EDIT_RUN_TARGET_UNSATISFIED"
        : "CANVAS_DIRECT_INTENT_RUN_TARGET_UNSATISFIED");
    }
    if (row.toolName === "quick_edit") {
      const input = canvasAgentToolInputSchemas.quick_edit.parse(readInput(row.request));
      quickEditTargets.push(parseAndAssertTarget(row, input.target));
      quickEditIds.push(row.id);
      continue;
    }
    if (row.toolName === "rename_screen") {
      const input = canvasAgentToolInputSchemas.rename_screen.parse(readInput(row.request));
      directIntents.push({
        id: row.id,
        sequence: row.sequence,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        requestHash: row.requestHash,
        target: parseAndAssertTarget(row, input.target),
        title: input.title,
      });
      continue;
    }
    if (row.toolName === "duplicate_screen") {
      const input = canvasAgentToolInputSchemas.duplicate_screen.parse(readInput(row.request));
      directIntents.push({
        id: row.id,
        sequence: row.sequence,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        requestHash: row.requestHash,
        target: parseAndAssertTarget(row, input.target),
      });
      continue;
    }
    throw new Error("CANVAS_MUTATION_TOOL_INVALID");
  }

  if (quickEditIds.length > 0 && directIntents.length > 0) {
    throw new Error("CANVAS_QUICK_EDIT_DIRECT_INTENT_MIXED");
  }
  const quickEditTarget = quickEditTargets[0];
  if (
    quickEditTarget
    && quickEditTargets.some((target) => canonicalJson(target) !== canonicalJson(quickEditTarget))
  ) {
    throw new Error("CANVAS_QUICK_EDIT_TARGETS_MIXED");
  }
  return directIntents.length > 0
    ? { mode: "direct", intents: directIntents }
    : quickEditTarget
      ? { mode: "quick_edit", invocationIds: quickEditIds, target: quickEditTarget }
      : { mode: "none" };
}

export function assertExactCanvasQuickEditTarget(
  request: StartRunRequest,
  target: CanvasScreenReference,
) {
  if (request.workflow !== "edit" || request.artifactTargets.length !== 1) {
    throw new Error("CANVAS_QUICK_EDIT_RUN_TARGET_INVALID");
  }
  const runTarget = request.artifactTargets[0]!;
  if (
    runTarget.screenIds.length !== 1
    || target.artifactId !== runTarget.artifactId
    || target.artifactVersionId !== runTarget.artifactVersionId
    || target.screenId !== runTarget.screenIds[0]
  ) {
    throw new Error("CANVAS_QUICK_EDIT_RUN_TARGET_INVALID");
  }
  return runTarget;
}

export function exactCanvasDirectIntentTarget(
  request: StartRunRequest,
  intents: readonly CanvasDirectIntent[],
) {
  if (request.workflow !== "edit" || request.artifactTargets.length !== 1 || intents.length === 0) {
    throw new Error("CANVAS_DIRECT_INTENT_EDIT_TARGET_INVALID");
  }
  const target = request.artifactTargets[0]!;
  if (target.screenIds.length !== 1) {
    throw new Error("CANVAS_DIRECT_INTENT_EDIT_TARGET_INVALID");
  }
  const reference = intents[0]!.target;
  if (intents.some((intent) => canonicalJson(intent.target) !== canonicalJson(reference))) {
    throw new Error("CANVAS_DIRECT_INTENT_TARGETS_MIXED");
  }
  if (
    reference.artifactId !== target.artifactId
    || reference.artifactVersionId !== target.artifactVersionId
    || reference.screenId !== target.screenIds[0]
  ) {
    throw new Error("CANVAS_DIRECT_INTENT_EDIT_TARGET_MISMATCH");
  }
  return { target, reference };
}

export function planCanvasDirectIntentsOverRuntimeResult(
  request: StartRunRequest,
  result: RuntimeResult,
  intents: readonly CanvasDirectIntent[],
): CanvasDirectIntentRuntimePlan {
  const { target } = exactCanvasDirectIntentTarget(request, intents);
  const artifactIndex = result.artifacts.findIndex((draft) => (
    draft.kind === "prototype"
    && draft.operation.kind === "revise"
    && draft.operation.target.artifactId === target.artifactId
    && draft.operation.target.artifactVersionId === target.artifactVersionId
  ));
  if (artifactIndex < 0 || result.artifacts.length !== 1) {
    throw new Error("CANVAS_DIRECT_INTENT_RUNTIME_REVISION_INVALID");
  }
  const originalDraft = result.artifacts[artifactIndex]!;
  if (originalDraft.kind !== "prototype" || originalDraft.operation.kind !== "revise") {
    throw new Error("CANVAS_DIRECT_INTENT_RUNTIME_REVISION_INVALID");
  }
  const applied = applyCanvasDirectIntents(originalDraft.content, intents);
  const effectiveDraft = {
    ...originalDraft,
    content: applied.document,
  } satisfies RuntimeArtifactDraft;
  const effectiveResult = {
    ...result,
    artifacts: result.artifacts.map((draft, index) => index === artifactIndex ? effectiveDraft : draft),
  } satisfies RuntimeResult;
  return {
    ...applied,
    intents: [...intents],
    artifactIndex,
    originalDraft,
    effectiveDraft,
    effectiveResult,
  };
}

export function applyCanvasDirectIntents(
  baseDocument: PrototypeDocument,
  intents: readonly CanvasDirectIntent[],
): AppliedCanvasDirectIntents {
  let document = prototypeDocumentSchema.parse(structuredClone(baseDocument));
  const duplicateEffects: CanvasDuplicateEffect[] = [];

  for (const intent of intents) {
    if (intent.toolName === "rename_screen") {
      const next = structuredClone(document) as PrototypeDocument;
      const screen = next.screens.find((candidate) => candidate.id === intent.target.screenId);
      if (!screen) throw new Error("CANVAS_DIRECT_INTENT_SCREEN_MISSING");
      screen.name = intent.title;
      next.revision += 1;
      document = prototypeDocumentSchema.parse(next);
      continue;
    }
    const stableInvocationKey = `${intent.id}:${intent.toolCallId}`;
    const duplicated = duplicateScreenDocument(document, intent.target.screenId, stableInvocationKey);
    document = duplicated.document;
    duplicateEffects.push({
      invocationId: intent.id,
      nodeKey: duplicateBoardNodeKey(stableInvocationKey),
      screen: duplicated.screen,
    });
  }
  return { document, duplicateEffects };
}

function parseAndAssertTarget(
  row: CanvasMutationInvocationRow,
  target: CanvasScreenReference,
) {
  if (
    row.targetBoardNodeId !== target.boardNodeId
    || row.targetArtifactId !== target.artifactId
    || row.targetArtifactVersionId !== target.artifactVersionId
    || row.targetScreenId !== target.screenId
  ) {
    throw new Error("CANVAS_MUTATION_TARGET_COLUMNS_INVALID");
  }
  return target;
}

function readInput(request: unknown): unknown {
  const record = asRecord(request);
  if (!record || !("input" in record)) throw new Error("CANVAS_MUTATION_REQUEST_INVALID");
  return record.input;
}

function compareInvocations(left: CanvasMutationInvocationRow, right: CanvasMutationInvocationRow) {
  return left.sequence === right.sequence
    ? left.id.localeCompare(right.id)
    : left.sequence - right.sequence;
}

function duplicateScreenDocument(
  document: PrototypeDocument,
  sourceScreenId: string,
  invocationId: string,
): { document: PrototypeDocument; screen: PrototypeDocument["screens"][number] } {
  const next = structuredClone(document) as PrototypeDocument;
  const source = next.screens.find((screen) => screen.id === sourceScreenId);
  if (!source) throw new Error("CANVAS_DIRECT_INTENT_SCREEN_MISSING");
  const prefix = `dup${sha256(invocationId).slice(0, 18)}`;
  let sequence = 0;
  const fresh = () => `${prefix}${(sequence += 1).toString(36)}`;
  const screenMap = new Map<string, string>([[source.id, fresh()]]);
  const sourceNodes = next.nodes.filter((node) => node.screenId === source.id);
  const nodeMap = new Map(sourceNodes.map((node) => [node.id, fresh()]));
  const pathMap = new Map(sourceNodes.flatMap((node) => node.kind === "vector"
    ? node.paths.map((path) => [path.id, fresh()] as const)
    : []));
  const sourceStates = next.states.filter((state) => state.screenId === source.id);
  const stateMap = new Map(sourceStates.map((state) => [state.id, fresh()]));
  const sourceActions = next.actions.filter((action) => sourceNodes.some((node) => node.actionIds.includes(action.id)));
  const actionMap = new Map(sourceActions.map((action) => [action.id, fresh()]));
  const sourceBindings = next.bindings.filter((binding) => sourceNodes.some((node) => node.bindingIds.includes(binding.id)));
  const bindingMap = new Map(sourceBindings.map((binding) => [binding.id, fresh()]));
  const variablePaths = [...new Set(sourceBindings.flatMap((binding) => binding.source.kind === "variable"
    ? [binding.source.path]
    : []))];
  const variablePathMap = new Map(variablePaths.map((path, index) => [path, `copy${prefix}.v${index + 1}`]));
  const sourceMotions = next.motions.filter((motion) => sourceNodes.some((node) => node.motionIds.includes(motion.id)));
  const motionMap = new Map(sourceMotions.map((motion) => [motion.id, fresh()]));
  const remap = (value: string | null, map: Map<string, string>) => value === null ? null : map.get(value) ?? value;

  const clonedNodes = sourceNodes.map((node) => {
    const cloned = structuredClone(node) as typeof node;
    cloned.id = nodeMap.get(node.id)!;
    cloned.screenId = screenMap.get(node.screenId)!;
    cloned.parentId = remap(node.parentId, nodeMap);
    if ("childIds" in cloned) cloned.childIds = cloned.childIds.map((id) => nodeMap.get(id) ?? id);
    cloned.actionIds = cloned.actionIds.map((id) => actionMap.get(id) ?? id);
    cloned.bindingIds = cloned.bindingIds.map((id) => bindingMap.get(id) ?? id);
    cloned.motionIds = cloned.motionIds.map((id) => motionMap.get(id) ?? id);
    if (cloned.kind === "vector") {
      cloned.paths = cloned.paths.map((path) => ({
        ...path,
        id: pathMap.get(path.id) ?? path.id,
      }));
    }
    return cloned;
  });
  const clonedStates = sourceStates.map((state) => ({
    ...structuredClone(state),
    id: stateMap.get(state.id)!,
    screenId: screenMap.get(state.screenId)!,
    overrides: state.overrides.map((override) => ({
      ...structuredClone(override),
      nodeId: nodeMap.get(override.nodeId) ?? override.nodeId,
    })),
  }));
  const clonedActions = sourceActions.map((action) => {
    const cloned = structuredClone(action) as typeof action;
    cloned.id = actionMap.get(action.id)!;
    cloned.nodeId = nodeMap.get(action.nodeId)!;
    if (cloned.kind === "navigate") cloned.targetScreenId = screenMap.get(cloned.targetScreenId) ?? cloned.targetScreenId;
    if (cloned.kind === "setState") cloned.targetStateId = stateMap.get(cloned.targetStateId) ?? cloned.targetStateId;
    if (cloned.kind === "submit") {
      cloned.bindingIds = cloned.bindingIds.map((id) => bindingMap.get(id) ?? id);
      cloned.successStateId = remap(cloned.successStateId, stateMap);
    }
    return cloned;
  });
  const clonedBindings = sourceBindings.map((binding) => {
    const cloned = structuredClone(binding) as typeof binding;
    cloned.id = bindingMap.get(binding.id)!;
    cloned.nodeId = nodeMap.get(binding.nodeId)!;
    if (cloned.source.kind === "state") {
      cloned.source.stateId = stateMap.get(cloned.source.stateId) ?? cloned.source.stateId;
    } else if (cloned.source.kind === "variable") {
      cloned.source.path = variablePathMap.get(cloned.source.path) ?? cloned.source.path;
    }
    return cloned;
  });
  const clonedVariables = variablePaths.flatMap((path) => {
    const variable = next.variables.find((candidate) => candidate.path === path);
    const nextPath = variablePathMap.get(path);
    return variable && nextPath ? [{ ...structuredClone(variable), path: nextPath }] : [];
  });
  const clonedMotions = sourceMotions.map((motion) => {
    const cloned = structuredClone(motion) as typeof motion;
    cloned.id = motionMap.get(motion.id)!;
    cloned.nodeId = nodeMap.get(motion.nodeId)!;
    cloned.stateId = remap(cloned.stateId, stateMap);
    cloned.actionId = remap(cloned.actionId, actionMap);
    return cloned;
  });
  const duplicate = {
    ...structuredClone(source),
    id: screenMap.get(source.id)!,
    name: `${source.name} copy`.slice(0, 240),
    route: uniqueRoute(next.screens.map((screen) => screen.route), `${source.route}-copy`),
    rootNodeId: nodeMap.get(source.rootNodeId)!,
    initialStateId: remap(source.initialStateId, stateMap),
  };
  next.screens.push(duplicate);
  next.nodes.push(...clonedNodes);
  next.states.push(...clonedStates);
  next.actions.push(...clonedActions);
  next.bindings.push(...clonedBindings);
  next.variables.push(...clonedVariables);
  next.motions.push(...clonedMotions);
  next.revision += 1;
  const parsed = prototypeDocumentSchema.parse(next);
  const parsedDuplicate = parsed.screens.find((screen) => screen.id === duplicate.id);
  if (!parsedDuplicate) throw new Error("CANVAS_DIRECT_INTENT_DUPLICATE_MISSING");
  return { document: parsed, screen: parsedDuplicate };
}

function uniqueRoute(existing: string[], base: string): string {
  let route = base.startsWith("/") ? base : `/${base}`;
  let index = 2;
  while (existing.includes(route)) route = `${base}-${index++}`;
  return route;
}

function duplicateBoardNodeKey(invocationId: string) {
  return `canvas:duplicate:${sha256(invocationId).slice(0, 32)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
