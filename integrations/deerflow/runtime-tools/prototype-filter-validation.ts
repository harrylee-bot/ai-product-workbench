import type {
  PrototypeDocument,
  PrototypeExpression,
  PrototypeNode,
} from "../../../packages/workbench-contracts/src/prototype.js";

type CategorySelect = Extract<PrototypeNode, { kind: "input" }>;
type RowButton = Extract<PrototypeNode, { kind: "button" }>;

function optionTest(expression: PrototypeExpression) {
  if (expression.kind !== "equals") return null;
  const { left, right } = expression;
  if (left.kind === "variable" && right.kind === "literal" && typeof right.value === "string") {
    return { path: left.path, option: right.value };
  }
  if (right.kind === "variable" && left.kind === "literal" && typeof left.value === "string") {
    return { path: right.path, option: left.value };
  }
  return null;
}

function categoryRowsByButton(
  container: Extract<PrototypeNode, { kind: "frame" }>,
  nodes: ReadonlyMap<string, PrototypeNode>,
  categories: ReadonlyMap<string, string>,
) {
  const groups = new Map<string, { categories: Set<string>; buttons: RowButton[] }>();
  for (const childId of container.childIds) {
    const row = nodes.get(childId);
    if (row?.kind !== "frame") continue;
    const children = row.childIds.map((id) => nodes.get(id));
    const categoryValues = new Set(children.flatMap((child) => {
      const value = child?.kind === "text" ? categories.get(child.text) : undefined;
      return value === undefined ? [] : [value];
    }));
    const [category] = categoryValues;
    if (categoryValues.size !== 1 || category === undefined) continue;
    for (const child of children) {
      if (child?.kind !== "button" || child.buttonType !== "button" || child.disabled) continue;
      const group = groups.get(child.label) ?? { categories: new Set<string>(), buttons: [] };
      group.categories.add(category);
      group.buttons.push(child);
      groups.set(child.label, group);
    }
  }
  return groups;
}

export function categoryListIssues(document: PrototypeDocument, editedScreenIds: readonly string[] = []) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const defaults = new Map(document.variables.map((variable) => [variable.path, variable.initialValue]));
  const selectByVariable = new Map<string, CategorySelect[]>();
  const enabledSelectsByScreen = new Map<string, { input: CategorySelect; initial: string }[]>();
  for (const binding of document.bindings) {
    const input = nodes.get(binding.nodeId);
    if (binding.property !== "value" || binding.source.kind !== "variable" || input?.kind !== "input" || input.inputType !== "select") continue;
    const inputs = selectByVariable.get(binding.source.path) ?? [];
    inputs.push(input);
    selectByVariable.set(binding.source.path, inputs);
    const initial = defaults.get(binding.source.path);
    if (!input.visible || input.disabled || typeof initial !== "string"
        || !input.options.some((option) => !option.disabled && option.value === initial)) continue;
    const screenSelects = enabledSelectsByScreen.get(input.screenId) ?? [];
    screenSelects.push({ input, initial });
    enabledSelectsByScreen.set(input.screenId, screenSelects);
  }
  const issues = document.bindings.flatMap((binding, bindingIndex) => {
    if (binding.property !== "visible" || binding.source.kind !== "expression") return [];
    const expression = binding.source.expression;
    if (expression.kind !== "or" || expression.operands.length !== 2) return [];
    const first = optionTest(expression.operands[0]!);
    const second = optionTest(expression.operands[1]!);
    if (!first || !second || first.path !== second.path || first.option === second.option) return [];
    const initial = defaults.get(first.path);
    if (initial !== first.option && initial !== second.option) return [];
    const restricted = first.option === initial ? second.option : first.option;
    const container = nodes.get(binding.nodeId);
    if (container?.kind !== "frame" || container.childIds.length < 2) return [];
    const inputs = (selectByVariable.get(first.path) ?? []).filter((input) => input.screenId === container.screenId);
    const input = inputs.length === 1 ? inputs[0] : undefined;
    if (!input?.options.some((option) => option.value === restricted) || !input.options.some((option) => option.value === initial)) return [];
    if (new Set(input.options.map((option) => option.label)).size !== input.options.length) return [];
    const categories = new Map(input.options.filter((option) => option.value !== initial).map((option) => [option.label, option.value]));
    if (![...categoryRowsByButton(container, nodes, categories).values()].some((group) => group.categories.size > 1)) return [];
    return [{
      code: "custom",
      path: ["content", "bindings", bindingIndex],
      message: "This visibility binding hides a whole list whose rows use different labels from the same category selector. Remove the list-level category restriction. Bind each row to its own category option value and, if required, its own title/search predicate. Bind the empty state to the absence of matching rows. Wire each required row button to its declared behavior.",
    }];
  });

  // A plain repeated button needs its own activation when a peer works or a
  // separate screen already declares a visible way to navigate back to this list.
  const activatingNodes = new Set<string>();
  const returnTargets = new Set<string>();
  for (const action of document.actions) {
    if (action.event !== "click" && action.event !== "press") continue;
    activatingNodes.add(action.nodeId);
    const trigger = nodes.get(action.nodeId);
    if (action.kind !== "navigate" || !trigger?.visible || trigger.screenId === action.targetScreenId) continue;
    if ("disabled" in trigger && trigger.disabled) continue;
    returnTargets.add(action.targetScreenId);
  }
  const editedScreens = new Set(editedScreenIds);
  const inactiveButtons = new Set(document.bindings.flatMap((binding) => (
    binding.property === "enabled" && binding.source.kind === "literal" && binding.source.value === false
      ? [binding.nodeId]
      : []
  )));
  function categoriesForScreen(screenId: string) {
    const candidates = enabledSelectsByScreen.get(screenId);
    if (candidates?.length !== 1) return;
    const { input, initial } = candidates[0]!;
    if (new Set(input.options.map((option) => option.label)).size !== input.options.length) return;
    const categories = new Map(input.options.filter((option) => !option.disabled && option.value !== initial)
      .map((option) => [option.label, option.value]));
    return categories.size > 1 ? categories : undefined;
  }
  const categoriesByScreen = new Map(document.screens.map((screen) => [screen.id, categoriesForScreen(screen.id)]));
  const nodeIndexes = new Map(document.nodes.map((node, index) => [node.id, index]));
  for (const container of document.nodes) {
    if (container.kind !== "frame" || container.childIds.length < 2) continue;
    if (editedScreens.size > 0 && !editedScreens.has(container.screenId)) continue;
    const categories = categoriesByScreen.get(container.screenId);
    if (!categories) continue;
    for (const group of categoryRowsByButton(container, nodes, categories).values()) {
      if (group.categories.size < 2) continue;
      if (!returnTargets.has(container.screenId) && !group.buttons.some((button) => activatingNodes.has(button.id))) continue;
      for (const button of group.buttons) {
        if (!button.visible || inactiveButtons.has(button.id) || activatingNodes.has(button.id)) continue;
        issues.push({
          code: "custom",
          path: ["content", "nodes", nodeIndexes.get(button.id)!, "actionIds"],
          message: "Give this enabled row button its own click or press action. Set the button's actionIds and the action's nodeId. If the containing row owns this navigation, move it to the button instead of duplicating it.",
        });
      }
    }
  }
  return issues;
}
