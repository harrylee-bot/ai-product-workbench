import type {
  PrototypeDocument,
  PrototypeExpression,
  PrototypeNode,
} from "../../../packages/workbench-contracts/src/prototype.js";

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

export function categoryFilterIssues(document: PrototypeDocument) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const defaults = new Map(document.variables.map((variable) => [variable.path, variable.initialValue]));
  const selectByVariable = new Map<string, Array<Extract<PrototypeNode, { kind: "input" }>>>();
  for (const binding of document.bindings) {
    const input = nodes.get(binding.nodeId);
    if (binding.property !== "value" || binding.source.kind !== "variable" || input?.kind !== "input" || input.inputType !== "select") continue;
    const inputs = selectByVariable.get(binding.source.path) ?? [];
    inputs.push(input);
    selectByVariable.set(binding.source.path, inputs);
  }
  return document.bindings.flatMap((binding, bindingIndex) => {
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
    const categoriesByButton = new Map<string, Set<string>>();
    for (const childId of container.childIds) {
      const row = nodes.get(childId);
      if (row?.kind !== "frame") continue;
      const children = row.childIds.map((id) => nodes.get(id));
      const categoryValues = new Set(children.flatMap((child) => {
        const value = child?.kind === "text" ? categories.get(child.text) : undefined;
        return value === undefined ? [] : [value];
      }));
      if (categoryValues.size !== 1) continue;
      const [category] = categoryValues;
      for (const child of children) {
        if (child?.kind !== "button" || child.buttonType !== "button" || child.disabled) continue;
        const used = categoriesByButton.get(child.label) ?? new Set<string>();
        used.add(category!);
        categoriesByButton.set(child.label, used);
      }
    }
    if (![...categoriesByButton.values()].some((used) => used.size > 1)) return [];
    return [{
      code: "custom",
      path: ["content", "bindings", bindingIndex],
      message: "This visibility binding hides a whole list whose rows use different labels from the same category selector. Remove the list-level category restriction. Bind each row to its own category option value and, if required, its own title/search predicate. Bind the empty state to the absence of matching rows. Wire each required row button to its declared behavior.",
    }];
  });
}
