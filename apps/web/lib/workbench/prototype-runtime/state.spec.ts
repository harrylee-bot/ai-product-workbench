import { prototypeDocumentSchema, type PrototypeNode } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  applyPrototypeRuntimeAction,
  createPrototypeRuntimeState,
  projectPrototypeRuntimeNode,
  prototypeRuntimeActions,
  prototypeRuntimeInputValue,
  prototypeRuntimeMotions,
  reconcilePrototypeRuntimeState,
  resetPrototypeRuntimeForm,
  updatePrototypeRuntimeInput,
} from "./state";

describe("Prototype runtime state", () => {
  it("projects explicit variables and active-state values, then updates linked inputs", () => {
    const document = fixture();
    const input = node(document.nodes, "input-email", "input");
    const text = node(document.nodes, "text-email", "text");
    const button = node(document.nodes, "button-submit", "button");
    const runtime = createPrototypeRuntimeState(document, "screen-main");

    expect(projectPrototypeRuntimeNode(document, runtime, input).value).toBe("");
    expect(projectPrototypeRuntimeNode(document, runtime, text).text).toBe("");
    expect(projectPrototypeRuntimeNode(document, runtime, button).text).toBe("Ready to submit");

    const changed = updatePrototypeRuntimeInput(document, runtime, input, "team@example.com");
    expect(projectPrototypeRuntimeNode(document, changed, input).value).toBe("team@example.com");
    expect(projectPrototypeRuntimeNode(document, changed, text).text).toBe("team@example.com");
    expect(projectPrototypeRuntimeNode(document, { ...changed, stateId: null }, button).text)
      .toBe("Submit");
  });

  it("applies navigation, state, URL, and deterministic submit effects", () => {
    const document = fixture();
    const input = node(document.nodes, "input-email", "input");
    const button = node(document.nodes, "button-submit", "button");
    const form = node(document.nodes, "form-main", "form");
    let runtime = updatePrototypeRuntimeInput(
      document,
      createPrototypeRuntimeState(document),
      input,
      "owner@example.com",
    );

    const submit = prototypeRuntimeActions(document, form, "submit")[0]!;
    const submitted = applyPrototypeRuntimeAction(document, runtime, submit);
    expect(submitted.state.stateId).toBe("state-submitted");
    expect(submitted.effect).toEqual({
      protocol: "workbench.prototype-submit.v1",
      actionId: "action-submit",
      documentId: "runtime-document",
      formNodeId: "form-main",
      kind: "submit",
      screenId: "screen-main",
      values: [{
        bindingId: "binding-input-value",
        fieldName: "email",
        nodeId: "input-email",
        value: "owner@example.com",
      }],
    });

    const open = prototypeRuntimeActions(document, input, "focus")[0]!;
    expect(applyPrototypeRuntimeAction(document, runtime, open).effect).toEqual({
      kind: "openUrl",
      target: "newWindow",
      url: "https://example.com/help",
    });

    const navigate = prototypeRuntimeActions(document, button, "click")[0]!;
    runtime = applyPrototypeRuntimeAction(document, runtime, navigate).state;
    expect(runtime).toMatchObject({ screenId: "screen-success", stateId: null });
  });

  it("normalizes input values and resolves token-backed motion timing", () => {
    const document = fixture();
    const input = node(document.nodes, "input-email", "input");
    expect(prototypeRuntimeInputValue(input, "next@example.com", false)).toBe("next@example.com");

    expect(prototypeRuntimeMotions(document, "action", {
      actionId: "action-submit",
      screenId: "screen-main",
    })).toMatchObject([{
      id: "motion-submit",
      delayMs: 20,
      durationMs: 180,
    }]);
  });

  it("preserves canonical date values and rejects loose date strings", () => {
    const document = fixture();
    const input = node(document.nodes, "input-email", "input");
    input.inputType = "date";

    expect(prototypeRuntimeInputValue(input, "2026-07-16", false)).toBe("2026-07-16");
    expect(prototypeRuntimeInputValue(input, "", false)).toBe("");
    expect(() => prototypeRuntimeInputValue(input, "2026-7-16", false))
      .toThrow("PROTOTYPE_DATE_INPUT_VALUE_INVALID");
  });

  it("resets only variables owned by the selected form", () => {
    const mutable = structuredClone(fixture());
    const root = node(mutable.nodes, "root-main", "frame");
    const secondaryForm = {
      ...base("form-secondary", "screen-main", root.id),
      kind: "form" as const,
      childIds: ["input-secondary"],
    };
    const secondaryInput = {
      ...base("input-secondary", "screen-main", secondaryForm.id),
      kind: "input" as const,
      inputType: "text" as const,
      fieldName: "secondary",
      label: "Secondary",
      placeholder: "Secondary",
      optionValue: null,
      options: [],
      required: false,
      disabled: false,
      bindingIds: ["binding-secondary"],
    };
    root.childIds.push(secondaryForm.id);
    mutable.nodes.push(secondaryForm, secondaryInput);
    mutable.variables.push({ path: "form.secondary", initialValue: "secondary-initial" });
    mutable.bindings.push({
      id: "binding-secondary",
      nodeId: secondaryInput.id,
      property: "value",
      source: { kind: "variable", path: "form.secondary" },
    });
    const document = prototypeDocumentSchema.parse(mutable);
    const primaryInput = node(document.nodes, "input-email", "input");
    const parsedSecondaryInput = node(document.nodes, secondaryInput.id, "input");
    let runtime = createPrototypeRuntimeState(document);
    runtime = updatePrototypeRuntimeInput(document, runtime, primaryInput, "primary-changed");
    runtime = updatePrototypeRuntimeInput(document, runtime, parsedSecondaryInput, "secondary-changed");

    const reset = resetPrototypeRuntimeForm(document, runtime, "form-main");

    expect(reset.variables).toEqual({
      "form.email": "",
      "form.secondary": "secondary-changed",
    });
  });

  it("models a radio field as one string variable across explicit option values", () => {
    const mutable = structuredClone(fixture());
    const form = node(mutable.nodes, "form-main", "form");
    const yes = node(mutable.nodes, "input-email", "input");
    yes.inputType = "radio";
    yes.fieldName = "choice";
    yes.optionValue = "yes";
    mutable.variables[0]!.initialValue = "yes";
    const no = {
      ...base("input-no", "screen-main", form.id),
      kind: "input" as const,
      inputType: "radio" as const,
      fieldName: "choice",
      label: "No",
      placeholder: "",
      optionValue: "no",
      options: [],
      required: false,
      disabled: false,
      bindingIds: ["binding-no"],
    };
    form.childIds.push(no.id);
    mutable.nodes.push(no);
    mutable.bindings.push({
      id: "binding-no",
      nodeId: no.id,
      property: "value",
      source: { kind: "variable", path: "form.email" },
    });
    const document = prototypeDocumentSchema.parse(mutable);
    const yesNode = node(document.nodes, yes.id, "input");
    const noNode = node(document.nodes, no.id, "input");
    const initial = createPrototypeRuntimeState(document);

    expect(projectPrototypeRuntimeNode(document, initial, yesNode).checked).toBe(true);
    expect(projectPrototypeRuntimeNode(document, initial, noNode).checked).toBe(false);

    const selectedNo = updatePrototypeRuntimeInput(
      document,
      initial,
      noNode,
      prototypeRuntimeInputValue(noNode, no.optionValue, true),
    );
    expect(projectPrototypeRuntimeNode(document, selectedNo, yesNode).checked).toBe(false);
    expect(projectPrototypeRuntimeNode(document, selectedNo, noNode).checked).toBe(true);
    expect(selectedNo.variables["form.email"]).toBe("no");
  });

  it("reconciles a streamed document without losing navigation or user input", () => {
    const previous = fixture();
    const input = node(previous.nodes, "input-email", "input");
    const typed = updatePrototypeRuntimeInput(
      previous,
      createPrototypeRuntimeState(previous, "screen-main"),
      input,
      "owner@example.com",
    );
    const navigated = applyPrototypeRuntimeAction(
      previous,
      typed,
      prototypeRuntimeActions(previous, node(previous.nodes, "button-submit", "button"), "click")[0]!,
    ).state;
    const next = structuredClone(previous);
    next.revision += 1;
    next.variables[0]!.initialValue = "generated@example.com";

    const reconciled = reconcilePrototypeRuntimeState(previous, next, navigated, "screen-main");

    expect(reconciled).toEqual({
      screenId: "screen-success",
      stateId: null,
      variables: { "form.email": "owner@example.com" },
    });
  });

  it("adopts new untouched defaults and falls back when the active screen disappears", () => {
    const previous = fixture();
    const runtime = createPrototypeRuntimeState(previous, "screen-main");
    const next = structuredClone(previous);
    next.variables[0]!.initialValue = "generated@example.com";
    next.screens = next.screens.filter((screen) => screen.id === "screen-success");
    next.nodes = next.nodes.filter((candidate) => candidate.screenId === "screen-success");
    next.states = [];
    next.actions = [];
    next.bindings = [];
    next.motions = [];

    expect(reconcilePrototypeRuntimeState(previous, next, runtime)).toEqual({
      screenId: "screen-success",
      stateId: null,
      variables: { "form.email": "generated@example.com" },
    });
  });
});

function fixture() {
  const root = {
    ...base("root-main", "screen-main", null),
    kind: "frame" as const,
    childIds: ["form-main"],
    clipContent: true,
  };
  const form = {
    ...base("form-main", "screen-main", root.id),
    kind: "form" as const,
    childIds: ["input-email", "text-email", "button-submit"],
    actionIds: ["action-submit"],
  };
  const input = {
    ...base("input-email", "screen-main", form.id),
    kind: "input" as const,
    inputType: "email" as const,
    fieldName: "email",
    label: "Email",
    placeholder: "name@example.com",
    optionValue: null,
    options: [],
    required: true,
    disabled: false,
    actionIds: ["action-help"],
    bindingIds: ["binding-input-value"],
  };
  const text = {
    ...base("text-email", "screen-main", form.id),
    kind: "text" as const,
    text: "Email preview",
    maxLines: 1,
    bindingIds: ["binding-text-value"],
  };
  const button = {
    ...base("button-submit", "screen-main", form.id),
    kind: "button" as const,
    label: "Submit",
    childIds: [],
    buttonType: "submit" as const,
    disabled: false,
    actionIds: ["action-success"],
    bindingIds: ["binding-button-state"],
    motionIds: ["motion-submit"],
  };
  const successRoot = { ...base("root-success", "screen-success", null), kind: "frame" as const, childIds: [], clipContent: true };
  return prototypeDocumentSchema.parse({
    protocol: "workbench.prototype.v1",
    documentId: "runtime-document",
    title: "Runtime",
    revision: 1,
    screens: [
      { id: "screen-main", name: "Main", route: "/", rootNodeId: root.id, initialStateId: "state-ready", viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: successRoot.id, initialStateId: null, viewport: { width: 390, height: 844 } },
    ],
    nodes: [root, form, input, text, button, successRoot],
    tokens: [
      { id: "duration-fast", name: "Fast", type: "duration", value: 180 },
      { id: "delay-short", name: "Short delay", type: "duration", value: 20 },
    ],
    assets: [],
    variables: [{ path: "form.email", initialValue: "" }],
    states: [
      { id: "state-ready", screenId: "screen-main", name: "Ready", values: { label: "Ready to submit" }, overrides: [{ nodeId: button.id, enabled: true }] },
      { id: "state-submitted", screenId: "screen-main", name: "Submitted", values: { label: "Submitted" }, overrides: [{ nodeId: button.id, enabled: false }] },
    ],
    actions: [
      { id: "action-help", nodeId: input.id, event: "focus", kind: "openUrl", url: "https://example.com/help", target: "newWindow" },
      { id: "action-submit", nodeId: form.id, event: "submit", kind: "submit", bindingIds: ["binding-input-value"], successStateId: "state-submitted" },
      { id: "action-success", nodeId: button.id, event: "click", kind: "navigate", targetScreenId: "screen-success" },
    ],
    bindings: [
      { id: "binding-input-value", nodeId: input.id, property: "value", source: { kind: "variable", path: "form.email" } },
      { id: "binding-text-value", nodeId: text.id, property: "text", source: { kind: "variable", path: "form.email" } },
      { id: "binding-button-state", nodeId: button.id, property: "text", source: { kind: "state", stateId: "state-ready", field: "label" } },
    ],
    motions: [{
      id: "motion-submit",
      nodeId: button.id,
      trigger: "action",
      stateId: null,
      actionId: "action-submit",
      property: "opacity",
      from: 0.5,
      to: 1,
      duration: { kind: "token", tokenId: "duration-fast" },
      delay: { kind: "token", tokenId: "delay-short" },
      easing: "easeOut",
    }],
  });
}

function node<K extends PrototypeNode["kind"]>(
  nodes: readonly PrototypeNode[],
  id: string,
  kind: K,
): Extract<PrototypeNode, { kind: K }> {
  return nodes.find((candidate): candidate is Extract<PrototypeNode, { kind: K }> => (
    candidate.id === id && candidate.kind === kind
  ))!;
}

function base(id: string, screenId: string, parentId: string | null) {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    id,
    screenId,
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(200),
      height: literal(48),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: { kind: "literal" as const, value: "#ffffff" },
      stroke: null,
      radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [] as string[],
    bindingIds: [] as string[],
    motionIds: [] as string[],
  };
}
