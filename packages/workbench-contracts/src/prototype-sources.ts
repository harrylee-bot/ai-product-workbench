import { z } from "zod";
import { sha256Schema } from "./files.js";
import {
  prototypeActionSchema,
  prototypeAssetSchema,
  prototypeBindingSchema,
  prototypeDocumentSchema,
  prototypeMotionSchema,
  prototypeNodeSchema,
  prototypeScreenSchema,
  prototypeStateSchema,
  prototypeTokenSchema,
  prototypeVariableSchema,
  type PrototypeAsset,
  type PrototypeBinding,
  type PrototypeDocument,
  type PrototypeNode,
  type PrototypeStyle,
} from "./prototype.js";

export const prototypeSourceNavigationTargetSchema = prototypeScreenSchema
  .omit({ initialStateId: true, rootNodeId: true })
  .strict();

export const prototypeSourceProjectionPayloadSchema = z.object({
  protocol: z.literal("workbench.prototype-source-projection.v1"),
  source: z.object({
    documentId: z.string().min(1),
    checksum: sha256Schema,
  }).strict(),
  title: z.string().min(1).max(240),
  revision: z.number().int().positive(),
  selectedScreenIds: z.array(z.string().min(1)).min(1).max(12),
  screens: z.array(prototypeScreenSchema).min(1).max(12),
  navigationTargets: z.array(prototypeSourceNavigationTargetSchema).max(500),
  nodes: z.array(prototypeNodeSchema).min(1).max(20_000),
  tokens: z.array(prototypeTokenSchema).max(2_000),
  assets: z.array(prototypeAssetSchema).max(2_000),
  variables: z.array(prototypeVariableSchema).max(2_000),
  states: z.array(prototypeStateSchema).max(5_000),
  actions: z.array(prototypeActionSchema).max(10_000),
  bindings: z.array(prototypeBindingSchema).max(10_000),
  motions: z.array(prototypeMotionSchema).max(10_000),
}).strict();

export const prototypeSourceProjectionSchema = prototypeSourceProjectionPayloadSchema.extend({
  projectionChecksum: sha256Schema,
}).strict();

export type PrototypeSourceProjectionPayload = z.infer<typeof prototypeSourceProjectionPayloadSchema>;
export type PrototypeSourceProjection = z.infer<typeof prototypeSourceProjectionSchema>;

export function projectPrototypeSourceScreens(
  input: PrototypeDocument,
  selectedScreenIds: readonly string[],
  sourceChecksum: string,
): PrototypeSourceProjectionPayload {
  const document = prototypeDocumentSchema.parse(input);
  sha256Schema.parse(sourceChecksum);
  if (
    selectedScreenIds.length === 0
    || selectedScreenIds.length > 12
    || new Set(selectedScreenIds).size !== selectedScreenIds.length
  ) {
    throw new Error("PROTOTYPE_SOURCE_SCREEN_SELECTION_INVALID");
  }

  const screensById = new Map(document.screens.map((screen) => [screen.id, screen]));
  if (selectedScreenIds.some((screenId) => !screensById.has(screenId))) {
    throw new Error("PROTOTYPE_SOURCE_SCREEN_SELECTION_INVALID");
  }
  const selected = new Set(selectedScreenIds);
  const screens = selectedScreenIds.map((screenId) => screensById.get(screenId)!);
  const selectedNodes = document.nodes.filter((node) => selected.has(node.screenId));
  const nodeIds = new Set(selectedNodes.map((node) => node.id));
  const states = sortById(document.states.filter((state) => selected.has(state.screenId)));
  const stateIds = new Set(states.map((state) => state.id));
  const bindings = sortById(document.bindings.filter((binding) => nodeIds.has(binding.nodeId)));
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const actions = sortById(document.actions.filter((action) => nodeIds.has(action.nodeId)));
  const actionIds = new Set(actions.map((action) => action.id));
  const motions = sortById(document.motions.filter((motion) => (
    nodeIds.has(motion.nodeId)
    && (motion.stateId === null || stateIds.has(motion.stateId))
    && (motion.actionId === null || actionIds.has(motion.actionId))
  )));
  const motionIds = new Set(motions.map((motion) => motion.id));
  const nodes = sortById(selectedNodes.map((node) => projectNodeReferences(
    node,
    actionIds,
    bindingIds,
    motionIds,
  )));

  const navigationTargetIds = new Set(actions.flatMap((action) => (
    action.kind === "navigate" && !selected.has(action.targetScreenId)
      ? [action.targetScreenId]
      : []
  )));
  const navigationTargets = sortById([...navigationTargetIds].map((screenId) => {
    const screen = screensById.get(screenId);
    if (!screen) throw new Error("PROTOTYPE_SOURCE_NAVIGATION_TARGET_INVALID");
    return {
      id: screen.id,
      name: screen.name,
      route: screen.route,
      viewport: screen.viewport,
    };
  }));

  const variablePaths = new Set(bindings.flatMap((binding) => (
    binding.source.kind === "variable" ? [binding.source.path] : []
  )));
  const variables = document.variables
    .filter((variable) => variablePaths.has(variable.path))
    .sort((left, right) => compareText(left.path, right.path));
  const tokenIds = referencedTokenIds(nodes, states, motions);
  const tokens = sortById(document.tokens.filter((token) => tokenIds.has(token.id)));
  const assetIds = referencedAssetIds(document, nodes, states, bindings, variables, tokens);
  const assets = sortById(document.assets.filter((asset) => assetIds.has(asset.id)));

  return prototypeSourceProjectionPayloadSchema.parse({
    protocol: "workbench.prototype-source-projection.v1",
    source: { documentId: document.documentId, checksum: sourceChecksum },
    title: document.title,
    revision: document.revision,
    selectedScreenIds: [...selectedScreenIds],
    screens,
    navigationTargets,
    nodes,
    tokens,
    assets,
    variables,
    states,
    actions,
    bindings,
    motions,
  });
}

function projectNodeReferences(
  node: PrototypeNode,
  actionIds: ReadonlySet<string>,
  bindingIds: ReadonlySet<string>,
  motionIds: ReadonlySet<string>,
): PrototypeNode {
  return {
    ...node,
    actionIds: node.actionIds.filter((id) => actionIds.has(id)),
    bindingIds: node.bindingIds.filter((id) => bindingIds.has(id)),
    motionIds: node.motionIds.filter((id) => motionIds.has(id)),
  };
}

function referencedTokenIds(
  nodes: readonly PrototypeNode[],
  states: PrototypeSourceProjectionPayload["states"],
  motions: PrototypeSourceProjectionPayload["motions"],
): Set<string> {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.kind === "token" && typeof record.tokenId === "string") ids.add(record.tokenId);
    if (Array.isArray(record.shadowTokenIds)) {
      for (const id of record.shadowTokenIds) if (typeof id === "string") ids.add(id);
    }
    Object.values(record).forEach(collect);
  };
  nodes.forEach((node) => {
    collect(node.layout);
    collect(node.style);
  });
  states.forEach((state) => state.overrides.forEach((override) => collect(override.style)));
  motions.forEach((motion) => {
    collect(motion.duration);
    collect(motion.delay);
  });
  return ids;
}

function referencedAssetIds(
  document: PrototypeDocument,
  nodes: readonly PrototypeNode[],
  states: PrototypeSourceProjectionPayload["states"],
  bindings: readonly PrototypeBinding[],
  variables: PrototypeSourceProjectionPayload["variables"],
  tokens: PrototypeSourceProjectionPayload["tokens"],
): Set<string> {
  const assetsById = new Map(document.assets.map((asset) => [asset.id, asset]));
  const statesById = new Map(states.map((state) => [state.id, state]));
  const variablesByPath = new Map(variables.map((variable) => [variable.path, variable]));
  const bindingsById = new Map(bindings.map((binding) => [binding.id, binding]));
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "image" || node.kind === "icon") ids.add(node.assetId);
  }
  for (const state of states) {
    for (const override of state.overrides) if (override.assetId) ids.add(override.assetId);
  }

  const imageVariablePaths = new Set<string>();
  for (const binding of bindings) {
    if (binding.property !== "imageAssetId") continue;
    const value = bindingValue(binding, statesById, variablesByPath);
    if (typeof value === "string" && assetsById.has(value)) ids.add(value);
    if (binding.source.kind === "variable") imageVariablePaths.add(binding.source.path);
  }
  for (const node of nodes) {
    if (node.kind !== "input" || node.inputType !== "select") continue;
    const usesImageVariable = node.bindingIds.some((bindingId) => {
      const binding = bindingsById.get(bindingId);
      return binding?.property === "value"
        && binding.source.kind === "variable"
        && imageVariablePaths.has(binding.source.path);
    });
    if (!usesImageVariable) continue;
    for (const option of node.options) if (assetsById.has(option.value)) ids.add(option.value);
  }

  const tokenById = new Map(tokens.map((token) => [token.id, token]));
  const fontFamilies = new Set<string>();
  const collectFamily = (style: PrototypeStyle | undefined): void => {
    const family = style?.typography?.fontFamily;
    if (!family) return;
    if (family.kind === "literal") fontFamilies.add(family.value);
    else {
      const token = tokenById.get(family.tokenId);
      if (token?.type === "fontFamily") fontFamilies.add(token.value);
    }
  };
  nodes.forEach((node) => collectFamily(node.style));
  states.forEach((state) => state.overrides.forEach((override) => collectFamily(override.style)));
  document.assets.forEach((asset) => {
    if (asset.kind === "font" && fontFamilies.has(asset.family)) ids.add(asset.id);
  });
  return ids;
}

function bindingValue(
  binding: PrototypeBinding,
  states: ReadonlyMap<string, PrototypeSourceProjectionPayload["states"][number]>,
  variables: ReadonlyMap<string, PrototypeSourceProjectionPayload["variables"][number]>,
): unknown {
  if (binding.source.kind === "literal") return binding.source.value;
  if (binding.source.kind === "variable") {
    return variables.get(binding.source.path)?.initialValue;
  }
  return states.get(binding.source.stateId)?.values[binding.source.field];
}

function sortById<Value extends { id: string }>(values: readonly Value[]): Value[] {
  return [...values].sort((left, right) => compareText(left.id, right.id));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
