import { describe, expect, it } from "vitest";
import { acceptPrototypeGeometry } from "./geometry-bridge";
import { createPrototypeSandboxDocument } from "./preview";
const identity = {
  sessionId: "session-1",
  revisionId: "revision-1",
  pageId: "page-1",
};
const node = {
  nodeId: "save",
  selector: '[data-wb-node="save"]',
  label: "Save",
  tag: "button",
  parentSelector: "main",
  x: 10,
  y: 20,
  width: 80,
  height: 40,
};
const message = {
  protocol: "workbench.studio.frame.v1",
  ...identity,
  sequence: 1,
  kind: "selection",
  viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
  node,
  layers: [],
};
describe("geometry identity and bounds", () => {
  it("accepts one current frame session and rejects stale sequence or identities", () => {
    expect(acceptPrototypeGeometry(message, identity, 0)?.node).toEqual(node);
    for (const field of ["sessionId", "revisionId", "pageId"])
      expect(
        acceptPrototypeGeometry({ ...message, [field]: "old" }, identity, 0),
      ).toBeNull();
    expect(acceptPrototypeGeometry(message, identity, 1)).toBeNull();
  });
  it("rejects nonfinite coordinates, oversized payloads and excess layers", () => {
    for (const width of [NaN, Infinity, -1, 32769])
      expect(
        acceptPrototypeGeometry(
          { ...message, node: { ...node, width } },
          identity,
          0,
        ),
      ).toBeNull();
    expect(
      acceptPrototypeGeometry(
        { ...message, layers: Array(121).fill(node) },
        identity,
        0,
      ),
    ).toBeNull();
  });
  it("adds bridge only to temporary copy while preserving sandbox CSP", () => {
    const original =
      "<html><head><title>Frozen</title></head><body>page</body></html>";
    const copy = createPrototypeSandboxDocument(original, identity);
    expect(copy).toContain("workbench.studio.frame.v1");
    expect(copy).toContain("connect-src 'none'");
    expect(original).not.toContain("geometry");
    expect(copy).not.toContain("allow-same-origin");
  });
});
