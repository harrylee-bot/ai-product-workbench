import { describe, expect, it } from "vitest";
import { prdDocumentV2Example, prdDocumentV3Example } from "../src/prd-example.js";
import { artifactVersionInlinePrdV3DetailSchema, createPrdV3ArtifactVersionRequestSchema } from "../src/artifacts.js";
import { prdBusinessSections, prdDocumentDiagrams, prdDocumentSchema, prdDocumentV3Schema, prdTableOfContentsEntriesForV3, type PrdDocumentV3 } from "../src/prd.js";
import { runtimeArtifactDraftSchema } from "../src/runtime.js";
import { sourceCitations } from "./knowledge-citation.fixture.js";

const candidate = () => structuredClone(prdDocumentV3Example);
function messages(document: PrdDocumentV3) {
  const result = prdDocumentV3Schema.safeParse(document);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}
function syncToc(document: PrdDocumentV3) {
  document.tableOfContents.entries = prdTableOfContentsEntriesForV3(document.sections.businessRequirements.functionSections.map((section) => section.title));
}

describe("workbench.prd.v3 functional sections", () => {
  it("keeps v2 readable and exposes actual section and diagram order", () => {
    expect(prdDocumentSchema.parse(prdDocumentV2Example).protocol).toBe("workbench.prd.v2");
    const document = prdDocumentV3Schema.parse(candidate());
    expect(prdBusinessSections(document).map((section) => section.title)).toEqual([
      "2.1页面链接", "2.2 任务提交与业务校验", "2.3 任务状态与失败恢复", "2.4 任务处理验收标准",
    ]);
    expect(prdDocumentDiagrams(document).map((diagram) => diagram.kind)).toEqual(["productFlow", "productArchitecture"]);
  });

  it("allows one functional section with embedded acceptance and no diagrams even with a degradation plan", () => {
    const document = candidate();
    const sections = document.sections.businessRequirements.functionSections;
    document.sections.businessRequirements.functionSections = [{
      id: sections[0]!.id, title: "2.2 任务提交、状态与恢复", blocks: sections.flatMap((section) => section.blocks), diagrams: [],
    }];
    syncToc(document);
    expect(messages(document)).toEqual([]);
  });

  it("allows an architecture diagram alone as figure 1 with two nodes and one edge", () => {
    const document = candidate();
    const section = document.sections.businessRequirements.functionSections[1]!;
    const diagram = structuredClone(section.diagrams[1]!);
    diagram.title = "图1 任务页面与处理能力";
    diagram.nodes = diagram.nodes.slice(0, 2);
    diagram.edges = diagram.edges.slice(0, 1);
    section.diagrams = [diagram];
    expect(messages(document)).toEqual([]);
  });

  it("permits repeated kinds in different functional modules with global figure numbering", () => {
    const document = candidate();
    const sections = document.sections.businessRequirements.functionSections;
    const architecture = structuredClone(sections[1]!.diagrams[1]!);
    sections[0]!.diagrams = [{ ...architecture, id: "arch-second-module", title: "图1 任务配置关系", nodes: architecture.nodes.map((node) => ({ ...node, id: `copy-${node.id}` })), edges: architecture.edges.map((edge) => ({ ...edge, id: `copy-${edge.id}`, from: `copy-${edge.from}`, to: `copy-${edge.to}` })) }];
    sections[1]!.diagrams[0]!.title = "图2 任务提交与异常恢复";
    sections[1]!.diagrams[1]!.title = "图3 处理能力与状态关系";
    expect(messages(document)).toEqual([]);
  });

  it("rejects skipped section numbers and stale manual TOC entries", () => {
    const document = candidate();
    document.sections.businessRequirements.functionSections[1]!.title = "2.5 跳号功能";
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("start with 2.3")]));
    syncToc(document);
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("start with 2.3")]));
  });

  it("checks stable section IDs in the global entity graph and resolves section references", () => {
    const document = candidate();
    const section = document.sections.businessRequirements.functionSections[0]!;
    section.blocks.push({ id: "section-reference", type: "paragraph", content: [{ type: "reference", targetType: "section", targetId: section.id, label: "提交规则" }] });
    expect(messages(document)).toEqual([]);
    section.id = "goal-main";
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("IR id must be globally unique")]));
  });

  it("preserves bidirectional typed acceptance checks across sections", () => {
    const document = candidate();
    const criterion = document.sections.businessRequirements.functionSections[2]!.blocks.find((block) => block.type === "acceptanceCriterion");
    if (!criterion || criterion.type !== "acceptanceCriterion") throw new Error("fixture criterion missing");
    criterion.requirementIds = ["missing-requirement"];
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("must reference requirement"), expect.stringContaining("unknown requirement")]));
  });

  it("validates acceptance quality wherever its table is embedded", () => {
    const document = candidate();
    const sections = document.sections.businessRequirements.functionSections;
    sections[0]!.blocks.push(...sections[2]!.blocks);
    sections.splice(2);
    syncToc(document);
    expect(messages(document)).toEqual([]);
    const table = sections[0]!.blocks.find((block) => block.type === "table" && block.id === "acceptance-table");
    if (!table || table.type !== "table") throw new Error("fixture table missing");
    table.rows[0]!.cells[2]!.content = [{ type: "text", text: "全部结果正确显示结果并符合预期。", marks: [] }];
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("observable results")]));
  });

  it("accepts substantive typed Given/When/Then criteria without requiring a standalone table", () => {
    const document = candidate();
    const section = document.sections.businessRequirements.functionSections[2]!;
    const table = section.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("fixture table missing");
    const criteria = table.rows.map((row, index) => ({ id: `criterion-embedded-${index}`, type: "acceptanceCriterion" as const, requirementIds: ["requirement-main"], given: structuredClone(row.cells[1]!.content), when: [{ type: "text" as const, text: "用户执行本验收项对应的操作", marks: [] }], then: structuredClone(row.cells[2]!.content) }));
    section.blocks = criteria;
    const requirement = document.sections.businessRequirements.functionSections[0]!.blocks.find((block) => block.type === "requirement");
    if (!requirement || requirement.type !== "requirement") throw new Error("fixture requirement missing");
    requirement.acceptanceCriterionIds = criteria.map((criterion) => criterion.id);
    expect(messages(document)).toEqual([]);
  });

  it("combines table and typed acceptance across functional sections without double-counting mirrors", () => {
    const document = candidate();
    const sections = document.sections.businessRequirements.functionSections;
    const table = sections[2]!.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("fixture table missing");
    const additional = table.rows.slice(1).map((row, index) => ({ id: `mixed-criterion-${index}`, type: "acceptanceCriterion" as const, requirementIds: ["requirement-main"], given: structuredClone(row.cells[1]!.content), when: [{ type: "text" as const, text: "执行本项对应操作", marks: [] }], then: structuredClone(row.cells[2]!.content) }));
    table.rows = table.rows.slice(0, 1);
    sections[0]!.blocks.push(...additional);
    const requirement = sections[0]!.blocks.find((block) => block.type === "requirement");
    if (!requirement || requirement.type !== "requirement") throw new Error("fixture requirement missing");
    requirement.acceptanceCriterionIds.push(...additional.map((block) => block.id));
    expect(messages(document)).toEqual([]);
    // A typed mirror of the visibility row is not a duplicate standard and
    // cannot supply an extra independent acceptance coverage slot.
    const mirror = { ...structuredClone(additional[0]!), id: "mixed-table-mirror", given: structuredClone(table.rows[0]!.cells[1]!.content), then: structuredClone(table.rows[0]!.cells[2]!.content) };
    sections[0]!.blocks.push(mirror);
    requirement.acceptanceCriterionIds.push(mirror.id);
    expect(messages(document)).toEqual([]);
  });

  it("rejects references to legacy sections absent from the v3 document", () => {
    const document = candidate();
    document.sections.businessRequirements.functionSections[0]!.blocks.push({ id: "dangling-legacy-section", type: "paragraph", content: [{ type: "reference", targetType: "section", targetId: "coreRules", label: "旧业务规则" }] });
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("unknown section reference: coreRules")]));
  });

  it("validates citations and section references in summary and degradation prose", () => {
    for (const field of ["summary", "degradation"] as const) {
      const document = candidate();
      const content = field === "summary" ? document.sections.businessRequirements.summary : document.sections.degradation.content;
      content.push({ type: "reference", targetType: "section", targetId: document.sections.businessRequirements.functionSections[0]!.id, label: "提交规则" });
      expect(messages(document)).toEqual([]);
      content.push({ type: "citation", citationId: "undeclared-source", label: "未声明来源" });
      content.push({ type: "reference", targetType: "section", targetId: "coreRules", label: "已移除的旧节" });
      expect(messages(document)).toEqual(expect.arrayContaining([
        expect.stringContaining("unknown citation: undeclared-source"),
        expect.stringContaining("unknown section reference: coreRules"),
      ]));
    }
  });

  it("does not let table mirrors hide duplicate criteria or table item labels", () => {
    const document = candidate();
    const sections = document.sections.businessRequirements.functionSections;
    const table = sections[2]!.blocks.find((block) => block.type === "table");
    const requirement = sections[0]!.blocks.find((block) => block.type === "requirement");
    if (!table || table.type !== "table" || !requirement || requirement.type !== "requirement") throw new Error("fixture missing");
    const mirror = {
      id: "mirrored-criterion", type: "acceptanceCriterion" as const, requirementIds: [requirement.id],
      given: structuredClone(table.rows[0]!.cells[1]!.content),
      when: [{ type: "text" as const, text: "执行本项对应操作", marks: [] }],
      then: structuredClone(table.rows[0]!.cells[2]!.content),
    };
    sections[2]!.blocks = [table, mirror];
    requirement.acceptanceCriterionIds = [mirror.id];
    expect(messages(document)).toEqual([]);
    const duplicate = { ...structuredClone(mirror), id: "mirrored-criterion-duplicate" };
    sections[2]!.blocks.push(duplicate);
    requirement.acceptanceCriterionIds.push(duplicate.id);
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("acceptance standards must be distinct")]));
    sections[2]!.blocks.pop();
    requirement.acceptanceCriterionIds.pop();
    table.rows[1]!.cells[1]!.content = structuredClone(table.rows[0]!.cells[1]!.content);
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("acceptance items must be distinct")]));
  });

  it("locates an invalid recovery diagram at its actual functional section", () => {
    const document = candidate();
    const diagram = document.sections.businessRequirements.functionSections[1]!.diagrams[0]!;
    diagram.edges = diagram.edges.filter((edge) => edge.label !== "校验失败");
    const result = prdDocumentV3Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("invalid recovery diagram accepted");
    expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["sections", "businessRequirements", "functionSections", 1, "diagrams", 0], message: expect.stringContaining("failure and recovery branch") })]));
    const invalidTable = candidate();
    const table = invalidTable.sections.businessRequirements.functionSections[2]!.blocks[1];
    if (!table || table.type !== "table") throw new Error("fixture table missing");
    table.rows[0]!.cells.pop();
    const tableResult = prdDocumentV3Schema.safeParse(invalidTable);
    expect(tableResult.success).toBe(false);
    if (tableResult.success) throw new Error("invalid table accepted");
    expect(tableResult.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["sections", "businessRequirements", "functionSections", 2, "blocks", 1, "rows", 0, "cells"], message: expect.stringContaining("exactly one cell") })]));
  });

  it("continues enforcing safety evidence instead of inferring APP from generic channel metadata", () => {
    const document = candidate();
    document.sections.safetyBaseline.rows[11] = { sequence: 12, applicability: "是", remarks: "APP加载后提供双清单。" };
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("affirmative semantic evidence")]));
    document.sections.safetyBaseline.rows[0] = { sequence: 1, applicability: "不涉及", remarks: null };
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("contradicts a requested function")]));
  });

  it("keeps non-applicable safety remarks empty for both persisted and revised v3 documents", () => {
    const document = candidate();
    document.sections.safetyBaseline.rows[11]!.remarks = "无依据的旁注";
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("must use null remarks")]));
  });

  it("rejects dangling diagram edges and duplicate kinds in the same section", () => {
    const document = candidate();
    const section = document.sections.businessRequirements.functionSections[1]!;
    section.diagrams[0]!.edges[0]!.to = "missing-node";
    section.diagrams[1]!.kind = "productFlow";
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("declared nodes"), expect.stringContaining("unique within a function section")]));
  });

  it("supports source-backed interface impact while preserving placeholder rejection", () => {
    const document = candidate();
    document.sections.businessRequirements.functionSections.push({ id: "section-interface-impact", title: "2.5 本需求涉及新增/修改的接口", blocks: [{ id: "interface-impact", type: "paragraph", content: [{ type: "text", text: "现有任务查询接口的结果需包含当前处理状态，任务创建及查询范围保持现有权限规则。", marks: [] }] }], diagrams: [] });
    syncToc(document);
    expect(messages(document)).toEqual([]);
    document.sections.businessRequirements.functionSections[3]!.blocks[0] = { id: "interface-impact", type: "paragraph", content: [{ type: "text", text: "接口路径待确认。", marks: [] }] };
    expect(messages(document)).toEqual(expect.arrayContaining([expect.stringContaining("placeholder wording")]));
  });

  it("accepts v3 through version creation and Runtime while rejecting mismatched schema versions", () => {
    const document = { ...candidate(), citations: sourceCitations };
    expect(createPrdV3ArtifactVersionRequestSchema.parse({ kind: "prd", baseArtifactVersionId: "version-previous", document }).document.protocol).toBe("workbench.prd.v3");
    const draft = { kind: "prd", schemaVersion: 3, title: document.title, content: document, citations: sourceCitations, operation: { kind: "create" } };
    expect(runtimeArtifactDraftSchema.safeParse(draft).success).toBe(true);
    expect(runtimeArtifactDraftSchema.safeParse({ ...draft, schemaVersion: 2 }).success).toBe(false);
    const detail = { artifactId: "artifact-prd", artifactVersionId: "version-prd", version: 1, status: "ready", checksum: "a".repeat(64), citations: sourceCitations, createdByRunId: null, knowledgeReleaseId: null, createdAt: "2026-10-29T00:00:00.000Z", contentMode: "inline", kind: "prd", schemaVersion: 3, content: document };
    expect(artifactVersionInlinePrdV3DetailSchema.safeParse(detail).success).toBe(true);
    expect(artifactVersionInlinePrdV3DetailSchema.safeParse({ ...detail, schemaVersion: 2 }).success).toBe(false);
  });
});
