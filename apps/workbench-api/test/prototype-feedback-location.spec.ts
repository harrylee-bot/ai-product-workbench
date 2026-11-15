import { describe, expect, it } from "vitest";
import {
  createPrototypeFeedbackRequestSchema,
  prototypeFeedbackSchema,
} from "@workbench/workbench-contracts";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import {
  feedbackAnchorIndex,
  resolveFeedbackLocation,
} from "../src/modules/prototypes/prototype-feedback-location.js";
const feedback = prototypeFeedbackSchema.parse({
  id: "feedback-one",
  projectId: "project-one",
  revisionId: "revision-source",
  createdById: "author-one",
  body: "Keep the original text",
  anchor: {
    sourceRevisionId: "revision-source",
    pageId: "screen-a",
    scope: "node",
    nodeId: "node-a",
    quote: "A",
  },
  status: "open",
  revision: 0,
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
  resolvedAt: null,
});
const index = (document: unknown = prototypeDocumentFixture()) =>
  feedbackAnchorIndex({
    pages: [{ id: "screen-a" }, { id: "screen-b" }],
    sourceDocument: document,
  });

describe("stable feedback locations", () => {
  it("finds only the exact node on its original page", () => {
    expect(
      resolveFeedbackLocation(feedback, "revision-target", index()),
    ).toMatchObject({
      status: "resolved",
      pageId: "screen-a",
      nodeId: "node-a",
    });
    expect(
      resolveFeedbackLocation(
        {
          ...feedback,
          anchor: { ...feedback.anchor!, scope: "node", nodeId: "node-b" },
        },
        "revision-target",
        index(),
      ),
    ).toMatchObject({
      status: "missing",
      reason: "node_missing",
      pageId: null,
      nodeId: null,
    });
  });
  it("does not use matching text or a different node as a fallback", () => {
    const document = prototypeDocumentFixture();
    document.nodes = document.nodes.map((node) =>
      node.id === "node-a"
        ? { ...node, id: "different-node" }
        : node.kind === "frame"
          ? {
              ...node,
              childIds: node.childIds.map((id) =>
                id === "node-a" ? "different-node" : id,
              ),
            }
          : node,
    );
    const resolved = resolveFeedbackLocation(
      feedback,
      "revision-target",
      index(document),
    );
    expect(resolved).toMatchObject({
      status: "missing",
      reason: "node_missing",
    });
    expect(resolved.feedback).toEqual(feedback);
  });
  it("preserves unidentifiable migrated anchors and invalid source documents as missing", () => {
    expect(
      resolveFeedbackLocation(feedback, "revision-target", index(null)),
    ).toMatchObject({ status: "missing", reason: "source_unavailable" });
    const migrated = {
      ...feedback,
      anchor: {
        scope: "unresolved" as const,
        sourceRevisionId: feedback.revisionId,
        pageId: "screen-a",
        quote: "A",
      },
    };
    expect(
      resolveFeedbackLocation(migrated, "revision-target", index()),
    ).toMatchObject({
      status: "missing",
      reason: "unidentified_node",
      feedback: migrated,
    });
  });
  it("rejects selector-only anchors, unsupported node identities, and new unresolved anchors", () => {
    for (const anchor of [
      { pageId: "screen-a", selector: "button" },
      { ...feedback.anchor, scope: "node", nodeId: 'node"] body' },
      {
        sourceRevisionId: feedback.revisionId,
        pageId: "screen-a",
        scope: "unresolved",
      },
    ])
      expect(
        createPrototypeFeedbackRequestSchema.safeParse({
          body: feedback.body,
          anchor,
        }).success,
      ).toBe(false);
  });
});
