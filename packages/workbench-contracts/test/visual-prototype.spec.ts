import { describe, expect, it } from "vitest";
import {
  prototypeExportSchema,
  prototypePageSchema,
  prototypeRevisionSchema,
  prototypeRevisionSummarySchema,
  prototypeRevisionListSchema,
  prototypeWorkflowActionRequestSchema,
} from "../src/visual-prototype.js";

const page = { id: "page_home", slug: "home", title: "Home", route: "/", order: 0, content: "<!doctype html><html><body><button>Go</button></body></html>", sha256: "a".repeat(64) };

describe("visual prototype v2 contract", () => {
  it("rejects unknown page fields and duplicate page ids", () => {
    expect(prototypePageSchema.safeParse({ ...page, extra: true }).success).toBe(false);
    expect(prototypeRevisionSchema.safeParse({
      id: "rev_1", projectId: "project_1", planId: "plan_1", revision: 1, status: "ready", title: "Home",
      pages: [page, { ...page, order: 1 }], documentSha256: "b".repeat(64), createdById: "user_1",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), failure: null,
    }).success).toBe(false);
  });

  it("keeps history summaries free of executable content", () => {
    const summary = { id: "rev_1", projectId: "project_1", planId: "plan_1", revision: 1, status: "ready", title: "Home", documentSha256: "b".repeat(64), createdById: "user_1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), failure: null };
    expect(prototypeRevisionListSchema.parse([summary])).toEqual([prototypeRevisionSummarySchema.parse(summary)]);
    expect(prototypeRevisionListSchema.safeParse([{ ...summary, pages: [page] }]).success).toBe(false);
    expect(prototypeRevisionListSchema.safeParse([{ ...summary, previewHtml: page.content }]).success).toBe(false);
    expect(prototypeRevisionSchema.parse({ ...summary, pages: [page] }).previewHtml).toBeNull();
  });

  it("requires a failure for failed exports and an artifact for success", () => {
    const base = { id: "export_1", projectId: "project_1", revisionId: "rev_1", format: "html" as const, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    expect(prototypeExportSchema.safeParse({ ...base, status: "failed", artifact: null, failure: null }).success).toBe(false);
    expect(prototypeExportSchema.safeParse({ ...base, status: "succeeded", artifact: null, failure: null }).success).toBe(false);
  });

  it("keeps action payload strict and bounded", () => {
    expect(prototypeWorkflowActionRequestSchema.parse({ reason: "needs a11y" })).toEqual({ reason: "needs a11y" });
    expect(prototypeWorkflowActionRequestSchema.safeParse({ reason: "x", unknown: true }).success).toBe(false);
  });
});
