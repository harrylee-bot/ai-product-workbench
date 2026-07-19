import { createHash } from "node:crypto";
import {
  boardNodeProtocol,
  canonicalJson,
  type DesignSystemDocument,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";
import type { ExportBuildRequest } from "../src/index.js";

const literal = (value: number) => ({ kind: "literal" as const, value });
const base = (id: string, screenId: string, parentId: string | null, width: number, height: number) => ({
  id,
  screenId,
  parentId,
  name: id,
  visible: true,
  layout: {
    mode: "absolute" as const,
    x: literal(0),
    y: literal(0),
    width: literal(width),
    height: literal(height),
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
    rotation: id === "button-next" ? 30 : 0,
    transformOrigin: id === "button-next" ? { x: 0.25, y: 0.75 } : { x: 0.5, y: 0.5 },
    fill: { kind: "literal" as const, value: "#ffffff" },
    stroke: null,
    radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
    shadowTokenIds: [],
    typography: null,
  },
  actionIds: [] as string[],
  bindingIds: [] as string[],
  motionIds: [] as string[],
});

export function prototypeFixture(): PrototypeDocument {
  return {
    protocol: "workbench.prototype.v1",
    documentId: "document-1",
    title: "Checkout",
    revision: 1,
    screens: [
      { id: "screen-home", name: "Home", route: "/", rootNodeId: "root-home", initialStateId: null, viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: "root-success", initialStateId: null, viewport: { width: 390, height: 844 } },
    ],
    nodes: [
      { ...base("root-home", "screen-home", null, 390, 844), kind: "frame", childIds: ["button-next"], clipContent: true },
      {
        ...base("button-next", "screen-home", "root-home", 160, 48),
        kind: "button",
        label: "Continue",
        childIds: [],
        buttonType: "button",
        disabled: false,
        actionIds: ["action-next"],
        motionIds: ["motion-next"],
      },
      { ...base("root-success", "screen-success", null, 390, 844), kind: "frame", childIds: [], clipContent: true },
    ],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [{ id: "action-next", nodeId: "button-next", event: "click", kind: "navigate", targetScreenId: "screen-success" }],
    bindings: [],
    motions: [{
      id: "motion-next",
      nodeId: "button-next",
      trigger: "action",
      stateId: null,
      actionId: "action-next",
      property: "opacity",
      from: 0.5,
      to: 1,
      duration: literal(180),
      delay: literal(0),
      easing: "easeOut",
    }],
  };
}

export function interactivePrototypeFixture(): PrototypeDocument {
  const at = <Node extends ReturnType<typeof base>>(node: Node, y: number): Node => ({
    ...node,
    layout: { ...node.layout, y: literal(y) },
  });
  const input = (
    id: string,
    inputType: "text" | "textarea" | "select" | "checkbox" | "radio",
    fieldName: string,
    y: number,
    optionValue: string | null = null,
  ) => ({
    ...at(base(id, "screen-home", "form-home", 220, inputType === "textarea" ? 72 : 36), y),
    kind: "input" as const,
    inputType,
    fieldName,
    label: fieldName,
    placeholder: `Enter ${fieldName}`,
    optionValue,
    options: inputType === "select"
      ? [
          { value: "basic", label: "Basic", disabled: false },
          { value: "pro", label: "Pro", disabled: false },
          { value: "legacy", label: "Legacy", disabled: true },
        ]
      : [],
    required: false,
    disabled: false,
  });
  const text = (id: string, value: string, y: number) => ({
    ...at(base(id, "screen-home", "form-home", 220, 28), y),
    kind: "text" as const,
    text: value,
    maxLines: 1,
  });
  const button = (id: string, label: string, y: number, buttonType: "button" | "submit" | "reset" = "button") => ({
    ...at(base(id, "screen-home", "form-home", 160, 36), y),
    kind: "button" as const,
    label,
    childIds: [],
    buttonType,
    disabled: false,
  });

  const email = {
    ...input("input-email", "text", "email", 20),
    actionIds: ["action-change", "action-focus", "action-blur"],
    bindingIds: ["binding-email"],
  };
  const notes = {
    ...input("input-notes", "textarea", "notes", 64),
    bindingIds: ["binding-notes"],
  };
  const plan = {
    ...input("input-plan", "select", "plan", 144),
    bindingIds: ["binding-plan"],
  };
  const terms = {
    ...input("input-terms", "checkbox", "terms", 188),
    bindingIds: ["binding-terms"],
  };
  const choice = {
    ...input("input-choice", "radio", "choice", 232, "yes"),
    bindingIds: ["binding-choice"],
  };
  const choiceNo = {
    ...input("input-choice-no", "radio", "choice", 252, "no"),
    bindingIds: ["binding-choice-no"],
  };
  const mirror = { ...text("text-mirror", "Mirror", 276), bindingIds: ["binding-mirror"] };
  const literalText = { ...text("text-literal", "Base literal", 312), bindingIds: ["binding-literal"] };
  const stateText = {
    ...text("text-state", "Waiting", 348),
    bindingIds: ["binding-state"],
    motionIds: ["motion-state"],
  };
  const clickButton = {
    ...button("button-click", "Click", 392),
    style: { ...button("button-click", "Click", 392).style, rotation: 30 },
    actionIds: ["action-click"],
    motionIds: ["motion-hover", "motion-action"],
  };
  const pressButton = {
    ...button("button-press", "Press", 436),
    actionIds: ["action-press"],
    motionIds: ["motion-press"],
  };
  const submitButton = button("button-submit", "Submit", 480, "submit");
  const resetButton = button("button-reset", "Reset", 524, "reset");
  const navigateButton = {
    ...button("button-navigate", "Next", 568),
    actionIds: ["action-navigate"],
  };
  const icon = {
    ...at(base("icon-heart", "screen-home", "form-home", 24, 24), 612),
    kind: "icon" as const,
    assetId: "icon-heart-asset",
    accessibilityLabel: "Favorite",
  };
  const formHome = {
    ...base("form-home", "screen-home", "root-home", 390, 660),
    kind: "form" as const,
    childIds: [
      email.id,
      notes.id,
      plan.id,
      terms.id,
      choice.id,
      choiceNo.id,
      mirror.id,
      literalText.id,
      stateText.id,
      clickButton.id,
      pressButton.id,
      submitButton.id,
      resetButton.id,
      navigateButton.id,
      icon.id,
    ],
    actionIds: ["action-submit"],
  };
  const rootHome = {
    ...base("root-home", "screen-home", null, 390, 680),
    kind: "frame" as const,
    childIds: [formHome.id],
    clipContent: true,
    motionIds: ["motion-enter", "motion-exit"],
  };
  const successText = {
    ...base("text-success", "screen-success", "root-success", 220, 40),
    kind: "text" as const,
    text: "Success screen",
    maxLines: 1,
  };
  const rootSuccess = {
    ...base("root-success", "screen-success", null, 390, 680),
    kind: "frame" as const,
    childIds: [successText.id],
    clipContent: true,
  };

  return {
    protocol: "workbench.prototype.v1",
    documentId: "interactive-document",
    title: "Interactive checkout",
    revision: 1,
    screens: [
      { id: "screen-home", name: "Home", route: "/", rootNodeId: rootHome.id, initialStateId: "state-idle", viewport: { width: 390, height: 680 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: rootSuccess.id, initialStateId: null, viewport: { width: 390, height: 680 } },
    ],
    nodes: [
      rootHome,
      formHome,
      email,
      notes,
      plan,
      terms,
      choice,
      choiceNo,
      mirror,
      literalText,
      stateText,
      clickButton,
      pressButton,
      submitButton,
      resetButton,
      navigateButton,
      icon,
      rootSuccess,
      successText,
    ],
    tokens: [],
    assets: [{
      id: "icon-heart-asset",
      kind: "icon",
      name: "Heart",
      library: "lucide",
      iconName: "heart",
    }],
    variables: [
      { path: "form.email", initialValue: "initial@example.test" },
      { path: "form.notes", initialValue: "Initial notes" },
      { path: "form.plan", initialValue: "pro" },
      { path: "form.terms", initialValue: false },
      { path: "form.choice", initialValue: "yes" },
    ],
    states: [
      {
        id: "state-idle",
        screenId: "screen-home",
        name: "Idle",
        values: { status: "Idle" },
        overrides: [{ nodeId: clickButton.id, enabled: true }],
      },
      {
        id: "state-ready",
        screenId: "screen-home",
        name: "Ready",
        values: { status: "Ready" },
        overrides: [{ nodeId: clickButton.id, enabled: true }],
      },
      {
        id: "state-submitted",
        screenId: "screen-home",
        name: "Submitted",
        values: { status: "Submitted" },
        overrides: [{ nodeId: stateText.id, text: "Submitted" }],
      },
    ],
    actions: [
      { id: "action-click", nodeId: clickButton.id, event: "click", kind: "setState", targetStateId: "state-ready" },
      { id: "action-press", nodeId: pressButton.id, event: "press", kind: "setState", targetStateId: "state-idle" },
      { id: "action-change", nodeId: email.id, event: "change", kind: "setState", targetStateId: "state-ready" },
      { id: "action-focus", nodeId: email.id, event: "focus", kind: "setState", targetStateId: "state-ready" },
      { id: "action-blur", nodeId: email.id, event: "blur", kind: "setState", targetStateId: "state-idle" },
      {
        id: "action-submit",
        nodeId: formHome.id,
        event: "submit",
        kind: "submit",
        bindingIds: ["binding-terms", "binding-email", "binding-choice"],
        successStateId: "state-submitted",
      },
      { id: "action-navigate", nodeId: navigateButton.id, event: "click", kind: "navigate", targetScreenId: "screen-success" },
    ],
    bindings: [
      { id: "binding-email", nodeId: email.id, property: "value", source: { kind: "variable", path: "form.email" } },
      { id: "binding-notes", nodeId: notes.id, property: "value", source: { kind: "variable", path: "form.notes" } },
      { id: "binding-plan", nodeId: plan.id, property: "value", source: { kind: "variable", path: "form.plan" } },
      { id: "binding-terms", nodeId: terms.id, property: "value", source: { kind: "variable", path: "form.terms" } },
      { id: "binding-choice", nodeId: choice.id, property: "value", source: { kind: "variable", path: "form.choice" } },
      { id: "binding-choice-no", nodeId: choiceNo.id, property: "value", source: { kind: "variable", path: "form.choice" } },
      { id: "binding-mirror", nodeId: mirror.id, property: "text", source: { kind: "variable", path: "form.email" } },
      { id: "binding-literal", nodeId: literalText.id, property: "text", source: { kind: "literal", value: "Literal ready" } },
      { id: "binding-state", nodeId: stateText.id, property: "text", source: { kind: "state", stateId: "state-ready", field: "status" } },
    ],
    motions: [
      { id: "motion-enter", nodeId: rootHome.id, trigger: "enter", stateId: null, actionId: null, property: "opacity", from: 0.9, to: 1, duration: literal(5), delay: literal(0), easing: "linear" },
      { id: "motion-exit", nodeId: rootHome.id, trigger: "exit", stateId: null, actionId: null, property: "opacity", from: 1, to: 0.9, duration: literal(5), delay: literal(0), easing: "linear" },
      { id: "motion-hover", nodeId: clickButton.id, trigger: "hover", stateId: null, actionId: null, property: "scale", from: 1, to: 1.02, duration: literal(5), delay: literal(0), easing: "easeOut" },
      { id: "motion-press", nodeId: pressButton.id, trigger: "press", stateId: null, actionId: null, property: "scale", from: 1, to: 0.98, duration: literal(5), delay: literal(0), easing: "easeOut" },
      { id: "motion-state", nodeId: stateText.id, trigger: "stateChange", stateId: "state-ready", actionId: null, property: "x", from: 0, to: 4, duration: literal(5), delay: literal(0), easing: "easeOut" },
      { id: "motion-action", nodeId: clickButton.id, trigger: "action", stateId: null, actionId: "action-click", property: "rotation", from: 0, to: 5, duration: literal(5), delay: literal(0), easing: "easeOut" },
    ],
  };
}

export function interactiveExportRequest(
  format: ExportBuildRequest["format"] = "html",
): ExportBuildRequest {
  const request = exportRequest(format);
  const content = interactivePrototypeFixture();
  const checksum = createHash("sha256").update(canonicalJson(content)).digest("hex");
  request.source.artifacts[0]!.content = content;
  request.source.artifacts[0]!.checksum = checksum;
  request.source.artifacts[0]!.title = content.title;
  request.source.manifest.artifacts[0]!.checksum = checksum;
  request.source.manifest.artifacts[0]!.title = content.title;
  request.source.boardSnapshot.nodes[0]!.data.title = content.title;
  request.source.boardSnapshot.nodes[0]!.size = { width: 390, height: 680 };
  return request;
}

export function exportRequest(format: ExportBuildRequest["format"] = "html"): ExportBuildRequest {
  const content = prototypeFixture();
  const checksum = createHash("sha256").update(canonicalJson(content)).digest("hex");
  const board = {
    id: "board-1",
    projectId: "project-1",
    revision: 3,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-1",
      kind: "artifact" as const,
      parentNodeId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 390, height: 844 },
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact" as const,
        title: "Checkout",
        artifactKind: "prototype" as const,
      },
    }],
    edges: [],
  };
  const pin = { position: 0, artifactId: "artifact-1", artifactVersionId: "version-1", title: "Checkout", kind: "prototype" as const, version: 1, schemaVersion: 1, checksum, assets: [] };
  return {
    format,
    packaging: format === "html" ? "single_file" : "zip",
    selection: { kind: "release" },
    options: {},
    source: {
      releaseId: "release-1",
      projectId: "project-1",
      releaseVersion: 1,
      boardSnapshot: board,
      manifest: { protocol: "workbench.project-release.v1", projectId: "project-1", releaseVersion: 1, board: { id: "board-1", revision: 3, checksum: "b".repeat(64) }, artifacts: [pin] },
      artifacts: [{
        position: 0,
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        kind: "prototype",
        title: "Checkout",
        version: 1,
        schemaVersion: 1,
        checksum,
        content,
        contentMediaType: "application/json",
        assets: [],
      }],
    },
  };
}

export function designSystemExportRequest(
  format: ExportBuildRequest["format"] = "html",
): ExportBuildRequest {
  const request = exportRequest(format);
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const fontBytes = Buffer.from("pinned-test-font", "utf8");
  const image = {
    id: "brand-image",
    name: "Brand image",
    kind: "image" as const,
    blobId: "blob-brand-image",
    mediaType: "image/png",
    byteSize: imageBytes.byteLength,
    sha256: createHash("sha256").update(imageBytes).digest("hex"),
    width: 1,
    height: 1,
  };
  const font = {
    id: "brand-font",
    name: "Brand font",
    kind: "font" as const,
    blobId: "blob-brand-font",
    mediaType: "font/woff2",
    byteSize: fontBytes.byteLength,
    sha256: createHash("sha256").update(fontBytes).digest("hex"),
    family: "Workbench Brand",
    weight: 600,
    style: "normal" as const,
  };
  const content: DesignSystemDocument = {
    protocol: "workbench.design-system.v1",
    documentId: "design-system-1",
    title: "Product UI",
    tokens: [{
      id: "token-primary",
      path: "color.primary",
      type: "color",
      value: { kind: "literal", value: "#112233" },
      description: "Primary brand color",
    }],
    assets: [image, font],
    principles: [],
    guidelines: [],
    components: [],
  };
  const checksum = createHash("sha256").update(canonicalJson(content)).digest("hex");
  const artifactId = "artifact-design-system";
  const artifactVersionId = "version-design-system";
  const binaryAssets = [
    {
      assetId: font.id,
      kind: font.kind,
      blobId: font.blobId,
      mediaType: font.mediaType,
      byteSize: font.byteSize,
      sha256: font.sha256,
      bytes: fontBytes,
    },
    {
      assetId: image.id,
      kind: image.kind,
      blobId: image.blobId,
      mediaType: image.mediaType,
      byteSize: image.byteSize,
      sha256: image.sha256,
      bytes: imageBytes,
    },
  ];
  const pin = {
    position: 0,
    artifactId,
    artifactVersionId,
    title: content.title,
    kind: "design_system" as const,
    version: 1,
    schemaVersion: 1,
    checksum,
    assets: [...content.assets]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((asset) => ({
        assetId: asset.id,
        kind: asset.kind,
        blobId: asset.blobId,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
        metadata: asset,
      })),
  };
  request.source.boardSnapshot.nodes = [{
    id: "node-design-system",
    kind: "artifact",
    parentNodeId: null,
    order: 0,
    position: { x: 0, y: 0 },
    size: { width: 800, height: 600 },
    artifactId,
    artifactVersionId,
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: content.title,
      artifactKind: "design_system",
    },
  }];
  request.source.manifest.artifacts = [pin];
  request.source.artifacts = [{
    position: 0,
    artifactId,
    artifactVersionId,
    kind: "design_system",
    title: content.title,
    version: 1,
    schemaVersion: 1,
    checksum,
    content,
    contentMediaType: "application/json",
    assets: binaryAssets,
  }];
  return request;
}
