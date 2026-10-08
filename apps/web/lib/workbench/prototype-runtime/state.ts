import {
  evaluatePrototypeExpression,
  isCanonicalPrototypeDateInputValue,
  type PrototypeAction,
  type PrototypeBinding,
  type PrototypeDocument,
  type PrototypeMotion,
  type PrototypeNode,
  type PrototypeRuntimeValue,
  type PrototypeState,
  type PrototypeSubmitDetail,
  type PublicPrototypeDocument,
} from "@workbench/workbench-contracts";

export type PrototypeRuntimeDocument = PrototypeDocument | PublicPrototypeDocument;

export const workbenchPrototypeSubmitEventName = "workbench:prototype-submit";

export type PrototypeRuntimeState = {
  screenId: string;
  stateId: string | null;
  variables: Readonly<Record<string, PrototypeRuntimeValue>>;
};

export type PrototypeRuntimeNodeProjection = {
  assetId: string | null;
  checked: boolean;
  enabled: boolean;
  stateOverride: PrototypeState["overrides"][number] | null;
  text: string | null;
  value: PrototypeRuntimeValue;
  visible: boolean;
};

export type PrototypeRuntimeEffect =
  | { kind: "openUrl"; target: "sameWindow" | "newWindow"; url: string }
  | PrototypeSubmitDetail;

export function createPrototypeRuntimeState(
  document: PrototypeRuntimeDocument,
  requestedScreenId?: string,
): PrototypeRuntimeState {
  const screen = document.screens.find((candidate) => candidate.id === requestedScreenId)
    ?? document.screens[0]!;
  return {
    screenId: screen.id,
    stateId: screen.initialStateId,
    variables: Object.fromEntries(
      document.variables.map((variable) => [variable.path, variable.initialValue]),
    ),
  };
}

export function reconcilePrototypeRuntimeState(
  previousDocument: PrototypeRuntimeDocument,
  nextDocument: PrototypeRuntimeDocument,
  runtime: PrototypeRuntimeState,
  requestedScreenId?: string,
): PrototypeRuntimeState {
  const previousScreen = previousDocument.screens.find((screen) => screen.id === runtime.screenId);
  const screen = nextDocument.screens.find((candidate) => candidate.id === runtime.screenId)
    ?? nextDocument.screens.find((candidate) => candidate.id === requestedScreenId)
    ?? nextDocument.screens[0]!;
  const stateStillExists = runtime.stateId === null
    || nextDocument.states.some((state) => state.id === runtime.stateId && state.screenId === screen.id);
  const retainedStateId = screen.id === runtime.screenId
    && stateStillExists
    && runtime.stateId !== previousScreen?.initialStateId
    ? runtime.stateId
    : screen.initialStateId;
  const previousVariables = new Map(
    previousDocument.variables.map((variable) => [variable.path, variable.initialValue]),
  );
  const variables = Object.fromEntries(nextDocument.variables.map((variable) => {
    const previousInitialValue = previousVariables.get(variable.path);
    const runtimeValue = runtime.variables[variable.path];
    const hasRuntimeValue = Object.prototype.hasOwnProperty.call(runtime.variables, variable.path);
    const userChangedValue = hasRuntimeValue
      && previousVariables.has(variable.path)
      && !Object.is(runtimeValue, previousInitialValue);
    return [variable.path, userChangedValue ? runtimeValue : variable.initialValue];
  }));

  return {
    screenId: screen.id,
    stateId: retainedStateId,
    variables,
  };
}

export function projectPrototypeRuntimeNode(
  document: PrototypeRuntimeDocument,
  runtime: PrototypeRuntimeState,
  node: PrototypeNode,
): PrototypeRuntimeNodeProjection {
  const activeState = runtime.stateId === null
    ? null
    : document.states.find((state) => state.id === runtime.stateId) ?? null;
  const stateOverride = activeState?.overrides.find((candidate) => candidate.nodeId === node.id)
    ?? null;
  const projection: PrototypeRuntimeNodeProjection = {
    assetId: node.kind === "image" || node.kind === "icon" ? node.assetId : null,
    checked: false,
    enabled: node.kind === "button" || node.kind === "input"
      ? !(node.disabled || stateOverride?.enabled === false)
      : true,
    stateOverride,
    text: node.kind === "text"
      ? stateOverride?.text ?? node.text
      : node.kind === "button"
        ? stateOverride?.text ?? node.label
        : null,
    value: null,
    visible: stateOverride?.visible ?? node.visible,
  };
  if (stateOverride?.assetId !== undefined) projection.assetId = stateOverride.assetId;

  const bindings = new Map(document.bindings.map((binding) => [binding.id, binding]));
  for (const bindingId of node.bindingIds) {
    const binding = bindings.get(bindingId);
    if (!binding) continue;
    const value = resolvePrototypeRuntimeBinding(document, runtime, binding);
    if (value === undefined) continue;
    if (binding.property === "text") projection.text = runtimeText(value);
    else if (binding.property === "value") {
      projection.value = value;
      if (node.kind === "input" && node.inputType === "checkbox") {
        projection.checked = value === true;
      } else if (node.kind === "input" && node.inputType === "radio") {
        projection.checked = typeof value === "string" && value === node.optionValue;
      }
    }
    else if (binding.property === "visible" && typeof value === "boolean") {
      projection.visible = value;
    } else if (binding.property === "enabled" && typeof value === "boolean") {
      projection.enabled = value;
    } else if (binding.property === "imageAssetId") {
      projection.assetId = typeof value === "string" && value.length > 0 ? value : null;
    }
  }
  return projection;
}

export function resolvePrototypeRuntimeBinding(
  document: PrototypeRuntimeDocument,
  runtime: PrototypeRuntimeState,
  binding: PrototypeBinding,
): PrototypeRuntimeValue | undefined {
  if (binding.source.kind === "literal") return binding.source.value;
  if (binding.source.kind === "variable") return runtime.variables[binding.source.path];
  if (binding.source.kind === "expression") {
    return evaluatePrototypeExpression(
      binding.source.expression,
      (path) => runtime.variables[path],
    );
  }
  const source = binding.source;
  if (runtime.stateId !== source.stateId) return undefined;
  return document.states.find((state) => state.id === source.stateId)
    ?.values[source.field];
}

export function updatePrototypeRuntimeInput(
  document: PrototypeRuntimeDocument,
  runtime: PrototypeRuntimeState,
  node: Extract<PrototypeNode, { kind: "input" }>,
  value: PrototypeRuntimeValue,
): PrototypeRuntimeState {
  let changed = false;
  const variables = { ...runtime.variables };
  const bindings = new Map(document.bindings.map((binding) => [binding.id, binding]));
  for (const bindingId of node.bindingIds) {
    const binding = bindings.get(bindingId);
    if (binding?.property !== "value" || binding.source.kind !== "variable") continue;
    if (Object.is(variables[binding.source.path], value)) continue;
    variables[binding.source.path] = value;
    changed = true;
  }
  return changed ? { ...runtime, variables } : runtime;
}

export function resetPrototypeRuntimeForm(
  document: PrototypeRuntimeDocument,
  runtime: PrototypeRuntimeState,
  formNodeId: string,
): PrototypeRuntimeState {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const nearestFormId = (nodeId: string) => {
    const visited = new Set<string>();
    let current = nodes.get(nodeId);
    while (current?.parentId) {
      if (visited.has(current.parentId)) return null;
      visited.add(current.parentId);
      const parent = nodes.get(current.parentId);
      if (!parent) return null;
      if (parent.kind === "form") return parent.id;
      current = parent;
    }
    return null;
  };
  const paths = new Set(document.bindings.flatMap((binding) => (
    binding.property === "value"
    && binding.source.kind === "variable"
    && nearestFormId(binding.nodeId) === formNodeId
      ? [binding.source.path]
      : []
  )));
  const initialValues = new Map(
    document.variables.map((variable) => [variable.path, variable.initialValue]),
  );
  const variables = { ...runtime.variables };
  let changed = false;
  for (const path of paths) {
    if (!initialValues.has(path)) continue;
    const initialValue = initialValues.get(path)!;
    if (Object.is(variables[path], initialValue)) continue;
    variables[path] = initialValue;
    changed = true;
  }
  return changed ? { ...runtime, variables } : runtime;
}

export function prototypeRuntimeInputValue(
  node: Extract<PrototypeNode, { kind: "input" }>,
  rawValue: string,
  checked: boolean,
): PrototypeRuntimeValue {
  if (node.inputType === "checkbox") return checked;
  if (node.inputType === "radio") return checked ? node.optionValue : null;
  if (node.inputType === "date") {
    if (!isCanonicalPrototypeDateInputValue(rawValue)) {
      throw new Error("PROTOTYPE_DATE_INPUT_VALUE_INVALID");
    }
    return rawValue;
  }
  if (node.inputType !== "number") return rawValue;
  if (rawValue === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

export function prototypeRuntimeActions(
  document: PrototypeRuntimeDocument,
  node: PrototypeNode,
  event: PrototypeAction["event"] | readonly PrototypeAction["event"][],
): PrototypeAction[] {
  const events = new Set(Array.isArray(event) ? event : [event]);
  const actions = new Map(document.actions.map((action) => [action.id, action]));
  return node.actionIds
    .map((id) => actions.get(id))
    .filter((action): action is PrototypeAction => Boolean(action && events.has(action.event)));
}

export function applyPrototypeRuntimeAction(
  document: PrototypeRuntimeDocument,
  runtime: PrototypeRuntimeState,
  action: PrototypeAction,
): { effect: PrototypeRuntimeEffect | null; state: PrototypeRuntimeState } {
  if (action.kind === "navigate") {
    const screen = document.screens.find((candidate) => candidate.id === action.targetScreenId);
    return {
      effect: null,
      state: screen
        ? { ...runtime, screenId: screen.id, stateId: screen.initialStateId }
        : runtime,
    };
  }
  if (action.kind === "setState") {
    return { effect: null, state: { ...runtime, stateId: action.targetStateId } };
  }
  if (action.kind === "openUrl") {
    return { effect: { kind: "openUrl", target: action.target, url: action.url }, state: runtime };
  }

  const bindings = new Map(document.bindings.map((binding) => [binding.id, binding]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const values = [...action.bindingIds].sort(compareStrings).flatMap((bindingId) => {
    const binding = bindings.get(bindingId);
    if (!binding) return [];
    const node = nodes.get(binding.nodeId);
    if (node?.kind !== "input" || binding.property !== "value") return [];
    return [{
      bindingId,
      fieldName: node.fieldName,
      nodeId: binding.nodeId,
      value: resolvePrototypeRuntimeBinding(document, runtime, binding) ?? null,
    }];
  });
  return {
    effect: {
      protocol: "workbench.prototype-submit.v1",
      kind: "submit",
      documentId: document.documentId,
      actionId: action.id,
      formNodeId: action.nodeId,
      screenId: runtime.screenId,
      values,
    },
    state: action.successStateId === null
      ? runtime
      : { ...runtime, stateId: action.successStateId },
  };
}

export function prototypeRuntimeMotions(
  document: PrototypeRuntimeDocument,
  trigger: PrototypeMotion["trigger"],
  options: {
    actionId?: string | null;
    nodeId?: string;
    screenId?: string;
    stateId?: string | null;
  } = {},
) {
  const tokens = new Map(document.tokens.map((token) => [token.id, token]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  return document.motions.flatMap((motion) => {
    if (motion.trigger !== trigger) return [];
    if (motion.stateId !== null && motion.stateId !== options.stateId) return [];
    if (motion.actionId !== null && motion.actionId !== options.actionId) return [];
    if (options.nodeId !== undefined && motion.nodeId !== options.nodeId) return [];
    const node = nodes.get(motion.nodeId);
    if (!node || (options.screenId !== undefined && node.screenId !== options.screenId)) return [];
    return [{
      ...motion,
      delayMs: runtimeNumber(motion.delay, tokens),
      durationMs: runtimeNumber(motion.duration, tokens),
    }];
  });
}

function runtimeText(value: PrototypeRuntimeValue) {
  return value === null ? "" : String(value);
}

function runtimeNumber(
  value: PrototypeMotion["duration"],
  tokens: Map<string, PrototypeRuntimeDocument["tokens"][number]>,
) {
  if (value.kind === "literal") return value.value;
  const token = tokens.get(value.tokenId);
  return token && typeof token.value === "number" ? token.value : 0;
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
