import { describe, expect, it } from "vitest";

import {
  isSafePrototypeOpenUrl,
  prototypeDocumentSchema,
  prototypeOpenUrlActionSchema,
  publicPrototypeDocumentSchema,
  type PrototypeDocument,
} from "../src/prototype.js";

const safeUrls = [
  "http://example.com/path?mode=preview#screen",
  "HTTPS://example.com/path",
  "mailto:designer@example.com",
  "mailto:designer@example.com?subject=Prototype%20review&cc=owner@example.com",
  "tel:+86 (138) 0013-8000;ext=12",
];

const unsafeUrls = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "blob:https://example.com/unsafe",
  " https://example.com",
  "https://example.com ",
  "https:/example.com",
  "http:\\example.com",
  "mailto:",
  "mailto:designer@example.com%0d%0abcc:attacker@example.com",
  "tel:javascript:alert(1)",
];

describe("Prototype openUrl security boundary", () => {
  it("fails closed for non-string runtime input", () => {
    expect(isSafePrototypeOpenUrl(null as never)).toBe(false);
    expect(isSafePrototypeOpenUrl({} as never)).toBe(false);
  });

  it.each(safeUrls)("accepts the explicitly supported URL %s", (url) => {
    expect(isSafePrototypeOpenUrl(url)).toBe(true);
    expect(prototypeOpenUrlActionSchema.safeParse(action(url)).success).toBe(true);
  });

  it.each(unsafeUrls)("rejects the unsafe or malformed URL %s", (url) => {
    expect(isSafePrototypeOpenUrl(url)).toBe(false);
    expect(prototypeOpenUrlActionSchema.safeParse(action(url)).success).toBe(false);
  });

  it("applies the same URL boundary to private and public Prototype documents", () => {
    expect(prototypeDocumentSchema.safeParse(documentWithUrl("https://example.com")).success)
      .toBe(true);
    expect(publicPrototypeDocumentSchema.safeParse(documentWithUrl("mailto:team@example.com")).success)
      .toBe(true);

    for (const url of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///tmp/unsafe",
      "blob:https://example.com/unsafe",
    ]) {
      expect(prototypeDocumentSchema.safeParse(documentWithUrl(url)).success).toBe(false);
      expect(publicPrototypeDocumentSchema.safeParse(documentWithUrl(url)).success).toBe(false);
    }
  });
});

describe("workbench.prototype.v1 static transform contract", () => {
  it("requires rotation and transform origin on every node without legacy defaults", () => {
    const missingRotation = documentWithUrl("https://example.com");
    delete (missingRotation.nodes[0]!.style as Partial<typeof missingRotation.nodes[0]["style"]>).rotation;
    expect(prototypeDocumentSchema.safeParse(missingRotation).success).toBe(false);

    const missingOrigin = documentWithUrl("https://example.com");
    delete (missingOrigin.nodes[0]!.style as Partial<typeof missingOrigin.nodes[0]["style"]>).transformOrigin;
    expect(prototypeDocumentSchema.safeParse(missingOrigin).success).toBe(false);
  });

  it.each([
    { rotation: -180, origin: { x: 0, y: 0 }, accepted: true },
    { rotation: 179.999, origin: { x: 1, y: 1 }, accepted: true },
    { rotation: 180, origin: { x: 0.5, y: 0.5 }, accepted: false },
    { rotation: -180.001, origin: { x: 0.5, y: 0.5 }, accepted: false },
    { rotation: 0, origin: { x: -0.001, y: 0.5 }, accepted: false },
    { rotation: 0, origin: { x: 0.5, y: 1.001 }, accepted: false },
  ])("validates canonical rotation/origin case %#", ({ rotation, origin, accepted }) => {
    const document = documentWithUrl("https://example.com");
    document.nodes[0]!.style.rotation = rotation;
    document.nodes[0]!.style.transformOrigin = origin;
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(accepted);
    expect(publicPrototypeDocumentSchema.safeParse(document).success).toBe(accepted);
  });
});

describe("workbench.prototype.v1 runtime binding contract", () => {
  it("requires every variable binding to reference one unique declared variable", () => {
    const document = documentWithUrl("https://example.com") as unknown as PrototypeDocument;
    document.variables = [{ path: "form.email", initialValue: "" }];
    document.nodes[1]!.bindingIds = ["binding-email"];
    document.bindings = [{
      id: "binding-email",
      nodeId: document.nodes[1]!.id,
      property: "text",
      source: { kind: "variable", path: "form.email" },
    }];

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);

    document.bindings[0]!.source = { kind: "variable", path: "form.missing" };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);

    document.variables.push({ path: "form.email", initialValue: "duplicate" });
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("requires state bindings to reference an explicit value on the same-screen state", () => {
    const document = documentWithUrl("https://example.com") as unknown as PrototypeDocument;
    document.states = [{
      id: "state-ready",
      screenId: "screen-main",
      name: "Ready",
      values: { status: "ready" },
      overrides: [{ nodeId: "button-open", enabled: true }],
    }];
    document.nodes[1]!.bindingIds = ["binding-status"];
    document.bindings = [{
      id: "binding-status",
      nodeId: document.nodes[1]!.id,
      property: "text",
      source: { kind: "state", stateId: "state-ready", field: "status" },
    }];

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);

    document.bindings[0]!.source = {
      kind: "state",
      stateId: "state-ready",
      field: "missing",
    };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects binding properties and value types that the target node cannot execute", () => {
    const document = documentWithUrl("https://example.com") as unknown as PrototypeDocument;
    document.variables = [{ path: "ui.visible", initialValue: "yes" }];
    document.nodes[1]!.bindingIds = ["binding-visible"];
    document.bindings = [{
      id: "binding-visible",
      nodeId: document.nodes[1]!.id,
      property: "visible",
      source: { kind: "variable", path: "ui.visible" },
    }];

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
    document.variables[0]!.initialValue = true;
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);

    document.bindings[0]!.property = "value";
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("applies the same referential integrity checks to public Prototype documents", () => {
    const document = documentWithForm();
    document.bindings[0]!.source = { kind: "variable", path: "form.missing" };

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
    expect(publicPrototypeDocumentSchema.safeParse(document).success).toBe(false);
  });
});

describe("workbench.prototype.v1 form contract", () => {
  it("requires explicit form ownership for submit buttons, actions, and bound inputs", () => {
    const outsideForm = documentWithUrl("https://example.com") as unknown as PrototypeDocument;
    const outsideButton = outsideForm.nodes[1];
    if (outsideButton?.kind !== "button") throw new Error("button fixture missing");
    outsideButton.buttonType = "submit";
    expect(prototypeDocumentSchema.safeParse(outsideForm).success).toBe(false);

    const valid = documentWithForm();
    expect(prototypeDocumentSchema.safeParse(valid).success).toBe(true);

    const submit = valid.actions.find((candidate) => candidate.kind === "submit")!;
    submit.nodeId = "frame-root";
    expect(prototypeDocumentSchema.safeParse(valid).success).toBe(false);
  });

  it("requires select options to be explicit, unique, and compatible with the value", () => {
    const document = documentWithForm();
    const input = document.nodes.find((candidate) => candidate.id === "input-email");
    if (input?.kind !== "input") throw new Error("input fixture missing");
    input.inputType = "select";
    input.options = [
      { value: "starter", label: "Starter", disabled: false },
      { value: "pro", label: "Pro", disabled: false },
    ];
    document.variables[0]!.initialValue = "pro";
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);

    input.options.push({ value: "pro", label: "Duplicate", disabled: false });
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
    input.options = [];
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("accepts only empty or canonical calendar dates for date inputs", () => {
    const document = documentWithForm();
    const input = document.nodes.find((candidate) => candidate.id === "input-email");
    if (input?.kind !== "input") throw new Error("input fixture missing");
    input.inputType = "date";

    for (const value of ["", "2026-07-16", "2024-02-29", "2000-02-29"]) {
      document.variables[0]!.initialValue = value;
      expect(prototypeDocumentSchema.safeParse(document).success, value).toBe(true);
    }
    for (const value of [
      "2026-7-16",
      "2026-02-29",
      "1900-02-29",
      "2026-13-01",
      "2026-00-01",
      "2026-07-00",
      "16/07/2026",
      "2026-07-16T00:00",
    ]) {
      document.variables[0]!.initialValue = value;
      expect(prototypeDocumentSchema.safeParse(document).success, value).toBe(false);
    }
  });

  it("uses one variable fact source per writable input, except one radio field", () => {
    const literal = documentWithForm();
    literal.bindings[0]!.source = { kind: "literal", value: "fixed" };
    expect(prototypeDocumentSchema.safeParse(literal).success).toBe(false);

    const shared = documentWithForm();
    const form = shared.nodes.find((candidate) => candidate.id === "form-main");
    if (form?.kind !== "form") throw new Error("form fixture missing");
    const secondary = {
      ...nodeBase("input-secondary", form.id),
      kind: "input" as const,
      inputType: "text" as const,
      fieldName: "secondary",
      label: "Secondary",
      placeholder: "",
      optionValue: null,
      options: [],
      required: false,
      disabled: false,
      bindingIds: ["binding-secondary"],
    };
    form.childIds.push(secondary.id);
    shared.nodes.push(secondary);
    shared.bindings.push({
      id: "binding-secondary",
      nodeId: secondary.id,
      property: "value",
      source: { kind: "variable", path: "form.email" },
    });
    expect(prototypeDocumentSchema.safeParse(shared).success).toBe(false);

    const checkbox = documentWithForm();
    const checkboxInput = checkbox.nodes.find((candidate) => candidate.id === "input-email");
    if (checkboxInput?.kind !== "input") throw new Error("input fixture missing");
    checkboxInput.inputType = "checkbox";
    checkbox.variables[0]!.initialValue = "false";
    expect(prototypeDocumentSchema.safeParse(checkbox).success).toBe(false);
  });

  it("rejects nested forms and interactive button children before HTML parsing", () => {
    const nested = documentWithForm();
    const outerForm = nested.nodes.find((candidate) => candidate.id === "form-main");
    const input = nested.nodes.find((candidate) => candidate.id === "input-email");
    if (outerForm?.kind !== "form" || input?.kind !== "input") {
      throw new Error("form fixture missing");
    }
    const innerForm = {
      ...nodeBase("form-inner", outerForm.id),
      kind: "form" as const,
      childIds: [input.id],
    };
    outerForm.childIds = [innerForm.id, "button-open"];
    input.parentId = innerForm.id;
    nested.nodes.splice(2, 0, innerForm);
    expect(prototypeDocumentSchema.safeParse(nested).success).toBe(false);

    const interactiveButton = documentWithForm();
    const form = interactiveButton.nodes.find((candidate) => candidate.id === "form-main");
    const button = interactiveButton.nodes.find((candidate) => candidate.id === "button-open");
    const childInput = interactiveButton.nodes.find((candidate) => candidate.id === "input-email");
    if (form?.kind !== "form" || button?.kind !== "button" || childInput?.kind !== "input") {
      throw new Error("button fixture missing");
    }
    form.childIds = [button.id];
    button.childIds = [childInput.id];
    childInput.parentId = button.id;
    expect(prototypeDocumentSchema.safeParse(interactiveButton).success).toBe(false);
  });

  it("requires unique value bindings and a same-screen submit success state", () => {
    const invalidProperty = documentWithForm();
    invalidProperty.bindings[0]!.property = "visible";
    expect(prototypeDocumentSchema.safeParse(invalidProperty).success).toBe(false);

    const duplicateBinding = documentWithForm();
    const duplicateSubmit = duplicateBinding.actions.find((candidate) => candidate.kind === "submit")!;
    duplicateSubmit.bindingIds.push(duplicateSubmit.bindingIds[0]!);
    expect(prototypeDocumentSchema.safeParse(duplicateBinding).success).toBe(false);

    const crossScreen = documentWithForm();
    const otherRoot = {
      ...nodeBase("frame-other", null),
      screenId: "screen-other",
      kind: "frame" as const,
      childIds: [] as string[],
      clipContent: true,
    };
    crossScreen.screens.push({
      id: "screen-other",
      name: "Other",
      route: "/other",
      rootNodeId: otherRoot.id,
      initialStateId: "state-other",
      viewport: { width: 390, height: 844 },
    });
    crossScreen.nodes.push(otherRoot);
    crossScreen.states.push({
      id: "state-other",
      screenId: "screen-other",
      name: "Other",
      values: {},
      overrides: [{ nodeId: otherRoot.id, visible: true }],
    });
    const crossScreenSubmit = crossScreen.actions.find((candidate) => candidate.kind === "submit")!;
    crossScreenSubmit.successStateId = "state-other";
    expect(prototypeDocumentSchema.safeParse(crossScreen).success).toBe(false);
  });
});

describe("workbench.prototype.v1 identity and executable event contract", () => {
  it("rejects duplicate top-level IR IDs and duplicate node references", () => {
    const duplicateId = documentWithForm();
    duplicateId.states = [
      {
        id: "state-duplicate",
        screenId: "screen-main",
        name: "First",
        values: { label: "first" },
        overrides: [{ nodeId: "button-open", enabled: true }],
      },
      {
        id: "state-duplicate",
        screenId: "screen-main",
        name: "Second",
        values: { label: "second" },
        overrides: [{ nodeId: "button-open", enabled: false }],
      },
    ];
    expect(prototypeDocumentSchema.safeParse(duplicateId).success).toBe(false);
    expect(publicPrototypeDocumentSchema.safeParse(duplicateId).success).toBe(false);

    const duplicateReference = documentWithForm();
    const button = duplicateReference.nodes.find((candidate) => candidate.id === "button-open");
    if (button?.kind !== "button") throw new Error("button fixture missing");
    button.actionIds = ["action-open", "action-open"];
    expect(prototypeDocumentSchema.safeParse(duplicateReference).success).toBe(false);
  });

  it("allows focus, blur, and change actions only on real input nodes", () => {
    const document = documentWithUrl("https://example.com");
    document.actions[0]!.event = "focus";

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
    expect(publicPrototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("treats click and press as one deterministic activation slot", () => {
    const document = documentWithUrl("https://example.com");
    const button = document.nodes.find((candidate) => candidate.id === "button-open");
    if (button?.kind !== "button") throw new Error("button fixture missing");
    button.actionIds.push("action-press");
    document.actions.push({
      id: "action-press",
      nodeId: button.id,
      event: "press",
      kind: "navigate",
      targetScreenId: "screen-main",
    });

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects state override properties that the target node cannot render", () => {
    const document = documentWithUrl("https://example.com");
    document.states = [{
      id: "state-invalid",
      screenId: "screen-main",
      name: "Invalid",
      values: {},
      overrides: [{ nodeId: "frame-root", enabled: true }],
    }];

    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
    expect(publicPrototypeDocumentSchema.safeParse(document).success).toBe(false);
  });
});

function action(url: string) {
  return {
    id: "action-open",
    nodeId: "button-open",
    event: "click" as const,
    kind: "openUrl" as const,
    url,
    target: "newWindow" as const,
  };
}

function documentWithUrl(url: string) {
  const root = {
    ...nodeBase("frame-root", null),
    kind: "frame" as const,
    childIds: ["button-open"],
    clipContent: true,
  };
  const button = {
    ...nodeBase("button-open", "frame-root"),
    kind: "button" as const,
    label: "Open",
    childIds: [],
    buttonType: "button" as const,
    disabled: false,
    actionIds: ["action-open"],
  };
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "prototype-url-security",
    title: "URL security",
    revision: 1,
    screens: [{
      id: "screen-main",
      name: "Main",
      route: "/",
      rootNodeId: root.id,
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [root, button],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [action(url)],
    bindings: [],
    motions: [],
  };
}

function documentWithForm(): PrototypeDocument {
  const document = documentWithUrl("https://example.com") as unknown as PrototypeDocument;
  const root = document.nodes[0];
  const button = document.nodes[1];
  if (root?.kind !== "frame" || button?.kind !== "button") {
    throw new Error("form fixture base is invalid");
  }
  const form = {
    ...nodeBase("form-main", root.id),
    kind: "form" as const,
    childIds: ["input-email", button.id],
    actionIds: ["action-submit"],
  };
  const input = {
    ...nodeBase("input-email", form.id),
    kind: "input" as const,
    inputType: "email" as const,
    fieldName: "email",
    label: "Email",
    placeholder: "name@example.com",
    optionValue: null,
    options: [],
    required: true,
    disabled: false,
    bindingIds: ["binding-email"],
  };
  root.childIds = [form.id];
  button.parentId = form.id;
  button.buttonType = "submit";
  document.nodes.splice(1, 0, form, input);
  document.variables = [{ path: "form.email", initialValue: "" }];
  document.actions.push({
    id: "action-submit",
    nodeId: form.id,
    event: "submit",
    kind: "submit",
    bindingIds: ["binding-email"],
    successStateId: null,
  });
  document.bindings = [{
    id: "binding-email",
    nodeId: input.id,
    property: "value",
    source: { kind: "variable", path: "form.email" },
  }];
  return document;
}

function nodeBase(id: string, parentId: string | null) {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    id,
    screenId: "screen-main",
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "flex" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: {
        top: literal(0),
        right: literal(0),
        bottom: literal(0),
        left: literal(0),
      },
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
      radii: {
        topLeft: literal(0),
        topRight: literal(0),
        bottomRight: literal(0),
        bottomLeft: literal(0),
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [] as string[],
    bindingIds: [] as string[],
    motionIds: [] as string[],
  };
}
