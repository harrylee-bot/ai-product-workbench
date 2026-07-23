import {
  prdSafetyBaselineItems,
  prdTableOfContentsEntriesFor,
  type ArtifactVersionDetail,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { describe, expect, it } from "vitest";

import { prdDocument } from "../../../components/workbench/workbench-prd-test-fixture";
import {
  artifactVersionPinCompatibility,
  projectArtifactVersion,
} from "./projection";

describe("ArtifactVersion comparison projection", () => {
  it("projects a structured PRD deterministically without editor JSON", () => {
    const projection = projectArtifactVersion(inlineVersion("prd", prdDocument()));

    expect(projection.note).toBeNull();
    expect(projection.text).toContain("# Production PRD");
    expect(projection.text).toContain("## 1. Executive summary");
    expect(projection.text).toContain("Initial summary sourceEvidenceGoal");
    expect(projection.text).toContain("前置条件：Given");
    expect(projection.text).toContain("触发操作：When");
    expect(projection.text).toContain("预期结果：Then");
    expect(projection.text).toContain("缓解措施：Mitigate");
  });

  it("projects the complete v2 template with both diagrams and every canonical safety item", () => {
    const projection = projectArtifactVersion(inlineVersion("prd", prdDocumentV2Example));

    expect(projection.text).toContain("# 示例工单需求说明书");
    expect(projection.text).toContain("## 版 本 历 史");
    expect(projection.text).toContain("## 目 录");
    expect(projection.text).toContain("### 1.1项目背景");
    expect(projection.text).toContain("### 2.4 验收标准");
    expect(projection.text).toContain("#### 图1 产品流程图");
    expect(projection.text).toContain("#### 图2 产品架构图");
    expect(projection.text).toContain("| 序号 | 活动投放的可选渠道 | 是否投放 |");
    for (const item of prdSafetyBaselineItems) {
      expect(projection.text).toContain(item.requirement);
    }
  });

  it("projects additional 2.5+ business sections between acceptance and degradation", () => {
    const document = structuredClone(prdDocumentV2Example);
    document.sections.businessRequirements.additionalSections = [{
      title: "2.5 配置规则",
      blocks: [{
        id: "additional-config-rule",
        type: "paragraph",
        content: [{ type: "text", text: "补充业务配置规则及对应结果。", marks: [] }],
      }],
    }];
    document.tableOfContents.entries = prdTableOfContentsEntriesFor(["2.5 配置规则"]);

    const projection = projectArtifactVersion(inlineVersion("prd", document));

    expect(projection.text).toContain("### 2.5 配置规则\n\n补充业务配置规则及对应结果。");
    expect(projection.text.indexOf("### 2.5 配置规则"))
      .toBeLessThan(projection.text.indexOf("## 3 业务降级方案（必填）"));
  });

  it("uses preferred code text and canonical JSON as deterministic fallbacks", () => {
    expect(projectArtifactVersion(inlineVersion("code", {
      language: "typescript",
      code: "const value = 1;\r\n",
    })).text).toBe("const value = 1;\n");

    expect(projectArtifactVersion(inlineVersion("document", {
      zeta: 1,
      alpha: { z: 2, a: 1 },
    })).text).toBe(JSON.stringify({ alpha: { a: 1, z: 2 }, zeta: 1 }, null, 2));
  });

  it("labels Prototype comparison as a structural summary rather than a pixel diff", () => {
    const projection = projectArtifactVersion(inlineVersion("prototype", prototypeDocument()));

    expect(projection.note).toMatch(/结构摘要.*不是像素差异/);
    expect(projection.text).toContain("Screens (1)");
    expect(projection.text).toContain("Nodes (1): node-root:frame");
    expect(projection.text).toContain("Actions (0)");
  });

  it("only permits a ready version that still contains the pinned screen", () => {
    const version = inlineVersion("prototype", prototypeDocument());
    expect(artifactVersionPinCompatibility({
      artifactId: "artifact-1",
      screenId: "screen-home",
    }, version)).toEqual({ allowed: true, reason: null });
    expect(artifactVersionPinCompatibility({
      artifactId: "artifact-1",
      screenId: "screen-missing",
    }, version)).toEqual({ allowed: false, reason: "该版本不包含当前画布界面" });
    expect(artifactVersionPinCompatibility({ artifactId: "artifact-1" }, {
      ...version,
      status: "rejected",
    })).toEqual({ allowed: false, reason: "只有已就绪版本可以固定到画布" });
  });
});

function inlineVersion(
  kind: "prd" | "prototype" | "code" | "document",
  content: unknown,
): ArtifactVersionDetail {
  return {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    version: 1,
    status: "ready",
    checksum: "a".repeat(64),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    contentMode: "inline",
    kind,
    schemaVersion: 1,
    content,
  } as ArtifactVersionDetail;
}

function prototypeDocument(): PrototypeDocument {
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-doc",
    title: "Prototype",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "node-root",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{ id: "node-root", kind: "frame" }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  } as unknown as PrototypeDocument;
}
