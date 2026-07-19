import { prototypeDocumentSchema } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  PROTOTYPE_NODE_ID_ATTRIBUTE,
  applyPrototypeTransformPatchBatch,
  applyPrototypeTransformPatch,
  centeredPrototypeRendererTransform,
  commandBatchFromTransformSnapshots,
  commandFromTransformSnapshot,
  createPrototypeTransformGestureBuffer,
  createPrototypeGroupRotationBaseline,
  groupRotationSnapshots,
  patchBatchFromTransformCommand,
  patchFromTransformCommand,
  prototypeNodeDomProps,
  rendererPointToDocument,
  rendererSizeToDocument,
  selectionFromDomTargets,
  selectionFromNodeIds,
} from "./model";
import { prototypeEditorDocumentFixture } from "./test-fixtures";

describe("prototype editor kernel model", () => {
  it("maps DOM targets to a deduplicated selection in document order", () => {
    const document = prototypeEditorDocumentFixture();
    const target = (nodeId: string | null) => ({
      getAttribute: (name: string) => name === PROTOTYPE_NODE_ID_ATTRIBUTE ? nodeId : null,
    });

    expect(prototypeNodeDomProps("node-card")).toEqual({
      [PROTOTYPE_NODE_ID_ATTRIBUTE]: "node-card",
    });
    expect(selectionFromDomTargets(document, "screen-main", [
      target("node-label"),
      target("node-card"),
      target("node-label"),
      target("node-foreign"),
      target(null),
    ])).toEqual({
      screenId: "screen-main",
      nodeIds: ["node-card", "node-label"],
    });
    expect(selectionFromNodeIds(document, "screen-main", [
      "node-label",
      "node-foreign",
      "node-card",
      "node-card",
    ])).toEqual({
      screenId: "screen-main",
      nodeIds: ["node-card", "node-label"],
    });
    expect(selectionFromNodeIds(document, "screen-other", ["node-card"])).toEqual({
      screenId: "screen-other",
      nodeIds: [],
    });
  });

  it.each([
    {
      zoom: 0.5,
      rendererPoint: { x: 450, y: 350 },
      rendererSize: { width: 100, height: 50 },
    },
    {
      zoom: 2,
      rendererPoint: { x: 300, y: -100 },
      rendererSize: { width: 400, height: 200 },
    },
  ])("converts centered renderer geometry to document coordinates at zoom $zoom", ({
    zoom,
    rendererPoint,
    rendererSize,
  }) => {
    const transform = centeredPrototypeRendererTransform(
      { width: 1_000, height: 1_000 },
      { width: 400, height: 800 },
      zoom,
    );

    expect(rendererPointToDocument(rendererPoint, transform)).toEqual({ x: 100, y: 100 });
    expect(rendererSizeToDocument(rendererSize, transform)).toEqual({ width: 200, height: 100 });
  });

  it("maps a Moveable-compatible move snapshot to a valid immutable IR patch", () => {
    const original = prototypeEditorDocumentFixture();
    const command = commandFromTransformSnapshot({
      kind: "move",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 40.12349,
      y: -0,
    });
    expect(command).toEqual({
      ok: true,
      value: {
        type: "prototype.node.move",
        nodeId: "node-card",
        screenId: "screen-main",
        x: 40.123,
        y: 0,
      },
    });
    if (!command.ok) throw new Error("expected move command");

    const patch = patchFromTransformCommand(original, command.value);
    expect(patch).toEqual({
      ok: true,
      value: {
        type: "prototype.node.transform.patch",
        nodeId: "node-card",
        screenId: "screen-main",
        layout: {
          x: { kind: "literal", value: 40.123 },
          y: { kind: "literal", value: 0 },
        },
      },
    });
    if (!patch.ok) throw new Error("expected move patch");

    const updated = applyPrototypeTransformPatch(original, patch.value);
    expect(prototypeDocumentSchema.safeParse(updated).success).toBe(true);
    expect(updated.revision).toBe(2);
    expect(updated.nodes[1].layout.x).toEqual({ kind: "literal", value: 40.123 });
    expect(original.nodes[1].layout.x).toEqual({ kind: "literal", value: 24 });
    expect(JSON.stringify(updated)).not.toMatch(/cssText|beforeDist/);
  });

  it("maps resize position and size to one deterministic layout patch", () => {
    const document = prototypeEditorDocumentFixture();
    const command = commandFromTransformSnapshot({
      kind: "resize",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 12.5,
      y: 36.25,
      width: 240.4999,
      height: 128,
    });
    if (!command.ok) throw new Error("expected resize command");
    const patch = patchFromTransformCommand(document, command.value);
    if (!patch.ok) throw new Error("expected resize patch");
    const updated = applyPrototypeTransformPatch(document, patch.value);

    expect(updated.nodes[1].layout).toMatchObject({
      x: { kind: "literal", value: 12.5 },
      y: { kind: "literal", value: 36.25 },
      width: { kind: "literal", value: 240.5 },
      height: { kind: "literal", value: 128 },
    });
    expect(prototypeDocumentSchema.safeParse(updated).success).toBe(true);
  });

  it("commits a group gesture as one atomic batch and one revision", () => {
    const document = prototypeEditorDocumentFixture();
    const commandBatch = commandBatchFromTransformSnapshots([
      {
        kind: "move",
        nodeId: "node-card",
        screenId: "screen-main",
        x: 30,
        y: 50,
      },
      {
        kind: "move",
        nodeId: "node-label",
        screenId: "screen-main",
        x: 38,
        y: 170,
      },
    ]);
    expect(commandBatch).toMatchObject({
      ok: true,
      value: {
        type: "prototype.nodes.transform.batch",
        screenId: "screen-main",
        commands: [{ nodeId: "node-card" }, { nodeId: "node-label" }],
      },
    });
    if (!commandBatch.ok) throw new Error("expected transform batch");
    const patchBatch = patchBatchFromTransformCommand(document, commandBatch.value);
    if (!patchBatch.ok) throw new Error("expected patch batch");
    const updated = applyPrototypeTransformPatchBatch(document, patchBatch.value);

    expect(updated.revision).toBe(document.revision + 1);
    expect(updated.nodes[1].layout.x).toEqual({ kind: "literal", value: 30 });
    expect(updated.nodes[2].layout.x).toEqual({ kind: "literal", value: 38 });
    expect(prototypeDocumentSchema.safeParse(updated).success).toBe(true);
  });

  it("rotates sibling coordinates and final angles around one stable group pivot", () => {
    const document = prototypeEditorDocumentFixture();
    const baseline = createPrototypeGroupRotationBaseline(
      document,
      "screen-main",
      ["node-card", "node-label"],
    );
    expect(baseline).toMatchObject({ ok: true, value: { pivot: { x: 104, y: 120 } } });
    if (!baseline.ok) throw new Error("expected group rotation baseline");
    const snapshots = groupRotationSnapshots(baseline.value, 90);
    expect(snapshots).toEqual({
      ok: true,
      value: [
        {
          kind: "rotate",
          nodeId: "node-card",
          screenId: "screen-main",
          degrees: 90,
          position: { x: 48, y: 72 },
        },
        {
          kind: "rotate",
          nodeId: "node-label",
          screenId: "screen-main",
          degrees: 90,
          position: { x: -16, y: 96 },
        },
      ],
    });
    if (!snapshots.ok) throw new Error("expected group rotation snapshots");
    const commands = commandBatchFromTransformSnapshots(snapshots.value);
    if (!commands.ok) throw new Error("expected group rotation commands");
    const patches = patchBatchFromTransformCommand(document, commands.value);
    if (!patches.ok) throw new Error("expected group rotation patches");
    const updated = applyPrototypeTransformPatchBatch(document, patches.value);

    expect(updated.revision).toBe(document.revision + 1);
    expect(updated.nodes[1]).toMatchObject({
      layout: { x: { value: 48 }, y: { value: 72 } },
      style: { rotation: 90, transformOrigin: { x: 0.5, y: 0.5 } },
    });
    expect(updated.nodes[2]).toMatchObject({
      layout: { x: { value: -16 }, y: { value: 96 } },
      style: { rotation: 90, transformOrigin: { x: 0.5, y: 0.5 } },
    });
  });

  it("projects a group rotation through differently rotated parent coordinate systems", () => {
    const document = nestedParentFixture();
    const baseline = createPrototypeGroupRotationBaseline(
      document,
      "screen-main",
      ["node-card", "node-label"],
    );
    if (!baseline.ok) throw new Error("expected nested group baseline");
    const snapshots = groupRotationSnapshots(baseline.value, 67.5);
    if (!snapshots.ok) throw new Error("expected nested group snapshots");
    const commands = commandBatchFromTransformSnapshots(snapshots.value);
    if (!commands.ok) throw new Error("expected nested group commands");
    const patches = patchBatchFromTransformCommand(document, commands.value);
    if (!patches.ok) throw new Error("expected nested group patches");
    const updated = applyPrototypeTransformPatchBatch(document, patches.value);
    const next = createPrototypeGroupRotationBaseline(
      updated,
      "screen-main",
      ["node-card", "node-label"],
    );
    if (!next.ok) throw new Error("expected updated nested group baseline");

    for (const original of baseline.value.nodes) {
      const after = next.value.nodes.find((node) => node.nodeId === original.nodeId)!;
      const originalPivot = applyAffine(original.world, original.origin);
      const expected = rotateAround(originalPivot, baseline.value.pivot, 67.5);
      const actual = applyAffine(after.world, after.origin);
      expect(actual.x).toBeCloseTo(expected.x, 2);
      expect(actual.y).toBeCloseTo(expected.y, 2);
    }
    expect(prototypeDocumentSchema.safeParse(updated).success).toBe(true);
  });

  it("keeps only top-level selected nodes so ancestor transforms are not applied twice", () => {
    const document = prototypeEditorDocumentFixture();
    expect(selectionFromNodeIds(document, "screen-main", ["node-root", "node-card", "node-label"]))
      .toEqual({ screenId: "screen-main", nodeIds: ["node-root"] });
  });

  it("keeps gesture frames as previews and exposes only the latest batch for commit", () => {
    const gesture = createPrototypeTransformGestureBuffer();
    const first = gesture.preview([{
      kind: "move",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 25,
      y: 49,
    }]);
    const latest = gesture.preview([{
      kind: "move",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 30,
      y: 54,
    }]);

    expect(first).toMatchObject({ ok: true, value: { commands: [{ x: 25, y: 49 }] } });
    expect(gesture.commit()).toEqual(latest);
    expect(gesture.commit()).toBeNull();
  });

  it("does not silently detach a token-backed layout value", () => {
    const document = prototypeEditorDocumentFixture();
    document.tokens.push({ id: "token-x", name: "X", type: "number", value: 24 });
    document.nodes[1].layout.x = { kind: "token", tokenId: "token-x" };
    const command = commandFromTransformSnapshot({
      kind: "move",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 40,
      y: 50,
    });
    if (!command.ok) throw new Error("expected move command");

    expect(patchFromTransformCommand(document, command.value)).toEqual({
      ok: false,
      code: "layout_value_is_token",
      nodeId: "node-card",
    });
  });

  it("persists a normalized final parent-local rotation without changing its origin", () => {
    const document = prototypeEditorDocumentFixture();
    const command = commandFromTransformSnapshot({
      kind: "rotate",
      nodeId: "node-card",
      screenId: "screen-main",
      degrees: 450,
      position: null,
    });
    expect(command).toEqual({
      ok: true,
      value: {
        type: "prototype.node.rotate",
        nodeId: "node-card",
        screenId: "screen-main",
        degrees: 90,
        position: null,
      },
    });
    if (!command.ok) throw new Error("expected rotate command");
    const patch = patchFromTransformCommand(document, command.value);
    expect(patch).toEqual({
      ok: true,
      value: {
        type: "prototype.node.transform.patch",
        nodeId: "node-card",
        screenId: "screen-main",
        style: { rotation: 90 },
      },
    });
    if (!patch.ok) throw new Error("expected rotate patch");
    const updated = applyPrototypeTransformPatch(document, patch.value);
    expect(updated.nodes[1].style.rotation).toBe(90);
    expect(updated.nodes[1].style.transformOrigin).toEqual({ x: 0.5, y: 0.5 });
    expect(prototypeDocumentSchema.safeParse(updated).success).toBe(true);
  });

  it("allows a flow node to rotate when the command does not rewrite layout", () => {
    const document = prototypeEditorDocumentFixture();
    document.nodes[1].layout.mode = "flow";
    const command = commandFromTransformSnapshot({
      kind: "rotate",
      nodeId: "node-card",
      screenId: "screen-main",
      degrees: -37.5,
      position: null,
    });
    if (!command.ok) throw new Error("expected rotate command");
    const patch = patchFromTransformCommand(document, command.value);
    expect(patch).toMatchObject({ ok: true, value: { style: { rotation: -37.5 } } });
  });

  it("fails the whole group rotation before commit for token-backed coordinates", () => {
    const document = prototypeEditorDocumentFixture();
    document.tokens.push({ id: "token-x", name: "X", type: "number", value: 24 });
    document.nodes[1].layout.x = { kind: "token", tokenId: "token-x" };
    expect(createPrototypeGroupRotationBaseline(
      document,
      "screen-main",
      ["node-card", "node-label"],
    )).toEqual({ ok: false, code: "layout_value_is_token", nodeId: "node-card" });
    expect(document.revision).toBe(1);
  });

  it("rejects non-finite and non-positive transform values", () => {
    expect(commandFromTransformSnapshot({
      kind: "move",
      nodeId: "",
      screenId: "screen-main",
      x: 0,
      y: 0,
    })).toEqual({ ok: false, code: "missing_dom_node_id", nodeId: "" });
    expect(commandFromTransformSnapshot({
      kind: "move",
      nodeId: "node-card",
      screenId: "screen-main",
      x: Number.NaN,
      y: 0,
    })).toMatchObject({ ok: false, code: "invalid_transform_number" });
    expect(commandFromTransformSnapshot({
      kind: "resize",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 0,
      y: 0,
      width: 0,
      height: 10,
    })).toMatchObject({ ok: false, code: "invalid_transform_number" });
    expect(commandFromTransformSnapshot({
      kind: "resize",
      nodeId: "node-card",
      screenId: "screen-main",
      x: 0,
      y: 0,
      width: 0.0004,
      height: 10,
    })).toMatchObject({ ok: false, code: "invalid_transform_number" });
  });
});

function nestedParentFixture() {
  const document = prototypeEditorDocumentFixture();
  const root = structuredClone(document.nodes[0]);
  const card = structuredClone(document.nodes[1]);
  const label = structuredClone(document.nodes[2]);
  if (root.kind !== "frame" || card.kind !== "frame") throw new Error("invalid fixture");
  const parentA = structuredClone(card);
  parentA.id = "parent-a";
  parentA.name = "parent-a";
  parentA.parentId = root.id;
  parentA.childIds = [card.id];
  parentA.layout.x = { kind: "literal", value: 20 };
  parentA.layout.y = { kind: "literal", value: 30 };
  parentA.layout.width = { kind: "literal", value: 220 };
  parentA.layout.height = { kind: "literal", value: 180 };
  parentA.style.rotation = 30;
  parentA.style.transformOrigin = { x: 0.25, y: 0.75 };
  const parentB = structuredClone(card);
  parentB.id = "parent-b";
  parentB.name = "parent-b";
  parentB.parentId = root.id;
  parentB.childIds = [label.id];
  parentB.layout.x = { kind: "literal", value: 190 };
  parentB.layout.y = { kind: "literal", value: 110 };
  parentB.layout.width = { kind: "literal", value: 170 };
  parentB.layout.height = { kind: "literal", value: 210 };
  parentB.style.rotation = -20;
  parentB.style.transformOrigin = { x: 0.8, y: 0.2 };
  root.childIds = [parentA.id, parentB.id];
  card.parentId = parentA.id;
  card.style.rotation = 12.5;
  label.parentId = parentB.id;
  label.style.rotation = -42;
  return {
    ...document,
    nodes: [root, parentA, card, parentB, label],
  };
}

function applyAffine(
  matrix: Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>,
  point: Readonly<{ x: number; y: number }>,
) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

function rotateAround(
  point: Readonly<{ x: number; y: number }>,
  pivot: Readonly<{ x: number; y: number }>,
  degrees: number,
) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - pivot.x;
  const y = point.y - pivot.y;
  return {
    x: pivot.x + cosine * x - sine * y,
    y: pivot.y + sine * x + cosine * y,
  };
}
