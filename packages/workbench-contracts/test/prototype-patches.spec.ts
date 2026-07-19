import { describe, expect, it } from "vitest";

import {
  PROTOTYPE_PATCH_MAX_OPERATIONS,
  PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES,
  PROTOTYPE_PATCH_MAX_REVISION,
  applyPrototypePatch,
  assertPrototypePatchPayloadSize,
  canonicalPrototypeScreenProjection,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  prototypePatchBatchSchema,
  prototypePatchCanonicalByteLength,
  prototypePatchCanonicalJson,
  prototypePatchEventPayloadSchema,
  prototypePatchOperationSchema,
  prototypePatchOperationsSchema,
  PrototypePatchError,
  type PrototypePatchBatch,
  type PrototypePatchOperation,
} from "../src/prototype-patches.js";
import type {
  PrototypeAction,
  PrototypeBinding,
  PrototypeDocument,
  PrototypeMotion,
  PrototypeState,
} from "../src/prototype.js";
import {
  prototypeDocumentFixture,
  prototypeFrameNodeFixture,
  prototypeTextNodeFixture,
} from "./prototype-fixture.js";

const checksum = "a".repeat(64);

function patch(
  operations: PrototypePatchOperation[],
  overrides: Partial<PrototypePatchBatch> = {},
): PrototypePatchBatch {
  return {
    screenId: "screen-a",
    baseRevision: 0,
    nextRevision: 1,
    operations,
    resultingChecksum: checksum,
    ...overrides,
  };
}

function state(id: string, screenId = "screen-a"): PrototypeState {
  return {
    id,
    screenId,
    name: id,
    values: { label: "active" },
    overrides: [{ nodeId: screenId === "screen-a" ? "node-a" : "node-b", visible: true }],
  };
}

function action(id: string, screenId = "screen-a"): PrototypeAction {
  return {
    id,
    nodeId: screenId === "screen-a" ? "node-a" : "node-b",
    event: "click",
    kind: "setState",
    targetStateId: screenId === "screen-a" ? "state-a" : "state-b",
  };
}

function binding(id: string, screenId = "screen-a"): PrototypeBinding {
  return {
    id,
    nodeId: screenId === "screen-a" ? "node-a" : "node-b",
    property: "text",
    source: { kind: "literal", value: "bound" },
  };
}

function motion(id: string, screenId = "screen-a"): PrototypeMotion {
  return {
    id,
    nodeId: screenId === "screen-a" ? "node-a" : "node-b",
    trigger: "stateChange",
    stateId: screenId === "screen-a" ? "state-a" : "state-b",
    actionId: null,
    property: "opacity",
    from: 0,
    to: 1,
    duration: { kind: "literal", value: 120 },
    delay: { kind: "literal", value: 0 },
    easing: "easeOut",
  };
}

describe("Prototype patch operation contracts", () => {
  it("accepts the twelve typed operations and rejects broad or non-v1 mutations", () => {
    const document = prototypeDocumentFixture();
    const screen = document.screens[0]!;
    const node = document.nodes[1]!;
    const operations: unknown[] = [
      { kind: "insert_node", parentId: "node-root-a", index: 0, node },
      { kind: "replace_node", nodeId: node.id, node },
      { kind: "remove_node", nodeId: node.id },
      { kind: "update_screen", screenId: screen.id, screen },
      { kind: "put_state", state: state("state-a") },
      { kind: "remove_state", stateId: "state-a" },
      { kind: "put_action", action: action("action-a") },
      { kind: "remove_action", actionId: "action-a" },
      { kind: "put_binding", binding: binding("binding-a") },
      { kind: "remove_binding", bindingId: "binding-a" },
      { kind: "put_motion", motion: motion("motion-a") },
      { kind: "remove_motion", motionId: "motion-a" },
    ];

    expect(operations.map((operation) => prototypePatchOperationSchema.parse(operation).kind))
      .toEqual(operations.map((operation) => (operation as { kind: string }).kind));
    expect(prototypePatchOperationSchema.safeParse({ ...operations[0] as object, selector: "#root" }).success)
      .toBe(false);
    expect(prototypePatchOperationSchema.safeParse({ kind: "update_token", tokenId: "token-a", value: 1 }).success)
      .toBe(false);
    expect(prototypePatchOperationSchema.safeParse({ kind: "update_props", nodeId: "node-a", props: {} }).success)
      .toBe(false);
  });

  it("enforces exact revision steps, strict payloads, and the operation cap", () => {
    const operation = { kind: "remove_node" as const, nodeId: "node-a" };
    expect(prototypePatchBatchSchema.safeParse(patch([operation])).success).toBe(true);
    expect(prototypePatchBatchSchema.safeParse(patch([operation], { nextRevision: 2 })).success).toBe(false);
    expect(prototypePatchBatchSchema.safeParse(patch([operation], {
      baseRevision: PROTOTYPE_PATCH_MAX_REVISION - 1,
      nextRevision: PROTOTYPE_PATCH_MAX_REVISION,
    })).success).toBe(true);
    expect(prototypePatchBatchSchema.safeParse(patch([operation], {
      baseRevision: PROTOTYPE_PATCH_MAX_REVISION,
      nextRevision: PROTOTYPE_PATCH_MAX_REVISION + 1,
    })).success).toBe(false);
    expect(prototypePatchBatchSchema.safeParse({ ...patch([operation]), unexpected: true }).success).toBe(false);
    expect(prototypePatchOperationsSchema.safeParse([]).success).toBe(false);
    expect(prototypePatchOperationsSchema.safeParse(
      Array.from({ length: PROTOTYPE_PATCH_MAX_OPERATIONS }, () => operation),
    ).success).toBe(true);
    expect(prototypePatchOperationsSchema.safeParse(
      Array.from({ length: PROTOTYPE_PATCH_MAX_OPERATIONS + 1 }, () => operation),
    ).success).toBe(false);
  });

  it("keeps source identity opaque and the event envelope strict", () => {
    const payload = {
      attempt: 1,
      runtimeAttemptId: "runtime/opaque:attempt",
      artifactIndex: 0,
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      sourceEventId: "runtime/tool-call#opaque",
      requestSha256: "f".repeat(64),
      ...patch([{ kind: "remove_node", nodeId: "node-a" }]),
    };
    expect(prototypePatchEventPayloadSchema.parse(payload)).toEqual(payload);
    expect(prototypePatchEventPayloadSchema.safeParse({ ...payload, detail: "internal" }).success).toBe(false);
  });
});

describe("Prototype patch apply engine", () => {
  it("atomically inserts, replaces, removes, and updates one screen", () => {
    const original = prototypeDocumentFixture();
    const inserted = prototypeTextNodeFixture("node-new", "screen-a", "node-root-a", "draft");
    const replacement = { ...inserted, parentId: "node-root-a", text: "ready" };
    const updatedScreen = { ...original.screens[0]!, name: "Updated A" };
    const applied = applyPrototypePatch(original, patch([
      { kind: "insert_node", parentId: "node-root-a", index: 1, node: inserted },
      { kind: "replace_node", nodeId: inserted.id, node: replacement },
      { kind: "remove_node", nodeId: "node-a" },
      { kind: "update_screen", screenId: "screen-a", screen: updatedScreen },
    ]));

    expect(original).toEqual(prototypeDocumentFixture());
    expect(applied.document.revision).toBe(original.revision);
    expect(applied.document.screens[0]!.name).toBe("Updated A");
    expect(applied.document.nodes.find((node) => node.id === "node-new")).toMatchObject({
      parentId: "node-root-a",
      text: "ready",
    });
    expect(applied.document.nodes.find((node) => node.id === "node-root-a")).toMatchObject({
      childIds: ["node-new"],
    });
    expect(applied.projection.revision).toBe(1);
    expect(applied.canonicalProjection).toBe(canonicalPrototypeScreenProjection(applied.projection));
  });

  it("puts and removes complete state, action, binding, and motion entities", () => {
    const original = prototypeDocumentFixture();
    const node = original.nodes.find((candidate) => candidate.id === "node-a")!;
    const withReferences = {
      ...node,
      actionIds: ["action-a"],
      bindingIds: ["binding-a"],
      motionIds: ["motion-a"],
    };
    const withEntities = applyPrototypePatch(original, patch([
      { kind: "replace_node", nodeId: node.id, node: withReferences },
      { kind: "put_state", state: state("state-a") },
      { kind: "put_action", action: action("action-a") },
      { kind: "put_binding", binding: binding("binding-a") },
      { kind: "put_motion", motion: motion("motion-a") },
      {
        kind: "update_screen",
        screenId: "screen-a",
        screen: { ...original.screens[0]!, initialStateId: "state-a" },
      },
    ])).document;
    expect(withEntities.states.map((entity) => entity.id)).toContain("state-a");
    expect(withEntities.actions.map((entity) => entity.id)).toContain("action-a");
    expect(withEntities.bindings.map((entity) => entity.id)).toContain("binding-a");
    expect(withEntities.motions.map((entity) => entity.id)).toContain("motion-a");

    const clearedNode = {
      ...withEntities.nodes.find((candidate) => candidate.id === "node-a")!,
      actionIds: [],
      bindingIds: [],
      motionIds: [],
    };
    const withoutEntities = applyPrototypePatch(withEntities, patch([
      {
        kind: "update_screen",
        screenId: "screen-a",
        screen: { ...withEntities.screens[0]!, initialStateId: null },
      },
      { kind: "replace_node", nodeId: "node-a", node: clearedNode },
      { kind: "remove_motion", motionId: "motion-a" },
      { kind: "remove_binding", bindingId: "binding-a" },
      { kind: "remove_action", actionId: "action-a" },
      { kind: "remove_state", stateId: "state-a" },
    ], { baseRevision: 1, nextRevision: 2 })).document;
    expect(withoutEntities.states).toEqual([]);
    expect(withoutEntities.actions).toEqual([]);
    expect(withoutEntities.bindings).toEqual([]);
    expect(withoutEntities.motions).toEqual([]);
  });

  it("rejects cross-screen puts and keeps the input unchanged", () => {
    const original = prototypeDocumentFixture();
    const operations: PrototypePatchOperation[] = [
      { kind: "put_state", state: state("state-b", "screen-b") },
      { kind: "put_action", action: action("action-b", "screen-b") },
      { kind: "put_binding", binding: binding("binding-b", "screen-b") },
      { kind: "put_motion", motion: motion("motion-b", "screen-b") },
    ];
    for (const operation of operations) {
      expect(() => applyPrototypePatch(original, patch([operation]))).toThrowError(
        expect.objectContaining({ code: "CROSS_SCREEN", operationIndex: 0 }),
      );
      expect(original).toEqual(prototypeDocumentFixture());
    }
  });

  it("rejects cross-screen removals for every screen-owned entity", () => {
    const base = prototypeDocumentFixture();
    const node = base.nodes.find((candidate) => candidate.id === "node-b")!;
    const populated = applyPrototypePatch(base, patch([
      { kind: "replace_node", nodeId: "node-b", node: {
        ...node,
        actionIds: ["action-b"],
        bindingIds: ["binding-b"],
        motionIds: ["motion-b"],
      } },
      { kind: "put_state", state: state("state-b", "screen-b") },
      { kind: "put_action", action: action("action-b", "screen-b") },
      { kind: "put_binding", binding: binding("binding-b", "screen-b") },
      { kind: "put_motion", motion: motion("motion-b", "screen-b") },
    ], { screenId: "screen-b" })).document;
    const removals: PrototypePatchOperation[] = [
      { kind: "remove_state", stateId: "state-b" },
      { kind: "remove_action", actionId: "action-b" },
      { kind: "remove_binding", bindingId: "binding-b" },
      { kind: "remove_motion", motionId: "motion-b" },
    ];
    for (const operation of removals) {
      expect(() => applyPrototypePatch(populated, patch([operation]))).toThrowError(
        expect.objectContaining({ code: "CROSS_SCREEN" }),
      );
    }
  });

  it("forbids root removal and structural identity replacement", () => {
    const document = prototypeDocumentFixture();
    expect(() => applyPrototypePatch(document, patch([
      { kind: "remove_node", nodeId: "node-root-a" },
    ]))).toThrowError(expect.objectContaining({ code: "ROOT_NODE_REMOVE_FORBIDDEN" }));
    expect(() => applyPrototypePatch(document, patch([
      {
        kind: "replace_node",
        nodeId: "node-a",
        node: { ...document.nodes.find((node) => node.id === "node-a")!, parentId: "node-root-b" },
      },
    ]))).toThrowError(expect.objectContaining({ code: "NODE_IDENTITY_CHANGE_FORBIDDEN" }));
    expect(() => applyPrototypePatch(document, patch([{
      kind: "insert_node",
      parentId: "node-root-a",
      index: 1,
      node: prototypeTextNodeFixture("node-forged", "screen-a", "node-root-b", "forged"),
    }]))).toThrowError(expect.objectContaining({ code: "NODE_IDENTITY_CHANGE_FORBIDDEN" }));
    expect(() => applyPrototypePatch(document, patch([{
      kind: "update_screen",
      screenId: "screen-a",
      screen: { ...document.screens[0]!, rootNodeId: "node-root-b" },
    }]))).toThrowError(expect.objectContaining({ code: "NODE_IDENTITY_CHANGE_FORBIDDEN" }));
    expect(() => applyPrototypePatch(document, patch([{
      kind: "insert_node",
      parentId: "node-root-a",
      index: 1,
      node: prototypeFrameNodeFixture(
        "node-prelinked",
        "screen-a",
        "node-root-a",
        ["node-a"],
      ),
    }]))).toThrowError(expect.objectContaining({ code: "INSERTED_NODE_CHILDREN_FORBIDDEN" }));
  });

  it("rejects cross-screen structural operations", () => {
    const document = prototypeDocumentFixture();
    const operations: PrototypePatchOperation[] = [
      { kind: "remove_node", nodeId: "node-b" },
      {
        kind: "replace_node",
        nodeId: "node-b",
        node: document.nodes.find((node) => node.id === "node-b")!,
      },
      {
        kind: "update_screen",
        screenId: "screen-b",
        screen: document.screens.find((screen) => screen.id === "screen-b")!,
      },
    ];
    for (const operation of operations) {
      expect(() => applyPrototypePatch(document, patch([operation])))
        .toThrowError(expect.objectContaining({ code: "CROSS_SCREEN" }));
    }
  });

  it("fails the whole batch when final PrototypeDocument validation fails", () => {
    const original = prototypeDocumentFixture();
    expect(() => applyPrototypePatch(original, patch([
      { kind: "put_state", state: state("state-a") },
      { kind: "put_action", action: action("action-a") },
    ]))).toThrowError(expect.objectContaining({ code: "DOCUMENT_INVALID" }));
    expect(original).toEqual(prototypeDocumentFixture());
  });
});

describe("Prototype screen projection and canonical payload helpers", () => {
  it("sorts screen-local entities and read-only shared resources stably", () => {
    const document = prototypeDocumentFixture();
    const reordered: PrototypeDocument = {
      ...document,
      screens: [...document.screens].reverse(),
      nodes: [...document.nodes].reverse(),
      variables: [...document.variables].reverse(),
    };
    const first = projectPrototypeScreen(document, "screen-a", 4);
    const second = projectPrototypeScreen(reordered, "screen-a", 4);
    expect(canonicalPrototypeScreenProjection(first)).toBe(canonicalPrototypeScreenProjection(second));
    expect(first.variables.map((variable) => variable.path)).toEqual(["shared.first", "shared.second"]);
    expect(first.nodes.every((node) => node.screenId === "screen-a")).toBe(true);
  });

  it("does not change one screen projection when only another screen changes", () => {
    const document = prototypeDocumentFixture();
    const changed = structuredClone(document);
    const node = changed.nodes.find((candidate) => candidate.id === "node-b")!;
    if (node.kind !== "text") throw new Error("fixture node kind changed");
    node.text = "changed B";
    expect(canonicalPrototypeScreenProjection(projectPrototypeScreen(document, "screen-a", 2)))
      .toBe(canonicalPrototypeScreenProjection(projectPrototypeScreen(changed, "screen-a", 2)));
  });

  it("delegates digesting without importing a platform crypto implementation", () => {
    const projection = projectPrototypeScreen(prototypeDocumentFixture(), "screen-a", 0);
    expect(computePrototypeScreenProjectionChecksum(projection, (canonical) => `digest:${canonical.length}`))
      .toBe(`digest:${canonicalPrototypeScreenProjection(projection).length}`);
  });

  it("counts canonical UTF-8 bytes and enforces the 256 KiB payload limit", () => {
    expect(prototypePatchCanonicalJson({ b: 2, a: 1 })).toBe(prototypePatchCanonicalJson({ a: 1, b: 2 }));
    expect(prototypePatchCanonicalByteLength({ value: "中" })).toBe(15);
    expect(assertPrototypePatchPayloadSize({ value: "x".repeat(PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES - 12) }))
      .toBe(PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES);
    expect(() => assertPrototypePatchPayloadSize({ value: "x".repeat(PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES - 11) }))
      .toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" } satisfies Partial<PrototypePatchError>));
  });
});
