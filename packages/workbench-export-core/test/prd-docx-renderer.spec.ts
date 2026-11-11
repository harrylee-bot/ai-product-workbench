import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { prdDocumentV2Schema, prdTableOfContentsEntriesFor } from "@workbench/workbench-contracts";
import { unzipSync, strFromU8 } from "fflate";
import { JSDOM } from "jsdom";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildExport } from "../src/index.js";
import { exportRequest } from "./fixtures.js";

const inline = (text: string) => [{ type: "text" as const, text, marks: [] }];

function allContentExample() {
  const document = structuredClone(prdDocumentV2Example);
  document.revision.number = 2;
  document.revision.summary = "完整保留第二次评审修订说明";
  document.revision.changedById = "revision-reviewer";
  document.versionHistory.push({
    status: "评审中", author: "第二版作者", participants: ["第二版参与者"],
    startDate: "2026-07-24", endDate: "2026-07-25", notes: "补充所有内容类型并记录第二次评审意见。",
  });
  document.citations.push({
    id: "citation-research", documentId: "research-document", chunkId: "research-chunk",
    sourcePath: "knowledge-vault/research.md", title: "业务调研原文", quote: "评审资料记录了业务用户的明确诉求。",
    locator: { heading: "调研访谈章节", startLine: 12, endLine: 18 },
  });
  document.assumptions[0]!.citationIds = ["citation-research"];
  document.sections.safetyBaseline.rows[0]!.remarks = "安全评审说明原文保留，不遗漏备注。";
  document.sections.businessRequirements.additionalSections = [{
    title: "2.5 业务补充说明",
    blocks: [
      { id: "rich-marks", type: "paragraph", content: [
        { type: "text", text: "强调文本", marks: ["strong"] },
        { type: "text", text: "斜体文本", marks: ["emphasis"] },
        { type: "text", text: "等宽文本", marks: ["code"] },
        { type: "text", text: "删除标记文本", marks: ["strikethrough"] },
        { type: "link", text: "业务资料链接", href: "/projects/current" },
        { type: "citation", citationId: "citation-research", label: "访谈来源" },
        { type: "reference", targetType: "requirement", targetId: "requirement-main", label: "关联业务需求" },
      ] },
      { id: "rich-heading", type: "heading", level: 3, content: inline("补充标题原文") },
      { id: "rich-ordered", type: "orderedList", items: [
        { id: "rich-first", content: inline("有序条目第一项") },
        { id: "rich-second", content: inline("有序条目第二项") },
      ] },
      { id: "rich-callout", type: "callout", tone: "warning", title: "业务补充结论", content: inline("结论中的完整说明原文") },
      { id: "rich-persona", type: "persona", name: "业务资料阅读者", description: inline("角色描述原文完整保留"),
        needs: ["了解业务材料的来源"], painPoints: ["材料说明分散"] },
      { id: "rich-risk", type: "risk", description: inline("资料整理可能延迟"), likelihood: "low", impact: "medium",
        mitigation: inline("预留资料整理时间并记录责任人") },
      { id: "wide-table", type: "table",
        columns: Array.from({ length: 6 }, (_, index) => ({ id: `wide-column-${index}`, label: `扩展列${index + 1}` })),
        rows: Array.from({ length: 2 }, (_, row) => ({
          id: `wide-row-${row}`,
          // Deliberately reorder the cells: columnId, not array position, is authoritative.
          cells: Array.from({ length: 6 }, (_, column) => ({
            columnId: `wide-column-${5 - column}`, content: inline(`第${row + 1}行第${6 - column}列完整内容`),
          })),
        })),
      },
    ],
  }];
  document.tableOfContents.entries = prdTableOfContentsEntriesFor(["2.5 业务补充说明"]);
  return prdDocumentV2Schema.parse(document);
}

function readDocx(bytes: Uint8Array) {
  const archive = unzipSync(bytes);
  const document = new JSDOM(strFromU8(archive["word/document.xml"]!), { contentType: "text/xml" }).window.document;
  const text = [...document.getElementsByTagName("w:t")].map((element) => element.textContent).join("");
  return { archive, document, text };
}

function expectedSourceText(value: unknown, key = ""): string[] {
  const meaningful = new Set([
    "text", "title", "label", "group", "remarks", "notes", "description", "successMetric",
    "actor", "trigger", "outcome", "statement", "name", "needs", "painPoints", "author",
    "participants", "sourcePath", "quote", "heading", "summary", "changedAt", "changedById",
  ]);
  if (Array.isArray(value)) return value.flatMap((item) => expectedSourceText(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([field, item]) => expectedSourceText(item, field));
  return typeof value === "string" && meaningful.has(key) ? [value] : [];
}

describe("Word and PDF document selection", () => {
  beforeEach(() => {
    vi.stubEnv("WORKBENCH_WEB_ORIGIN", "https://workbench.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves Markdown tables, nested lists, emphasis, links, quotes and code as Word structures", async () => {
    const request = exportRequest("docx");
    request.packaging = "single_file";
    request.source.artifacts[0] = {
      ...request.source.artifacts[0]!, kind: "document", schemaVersion: 1, title: "结构化会议纪要",
      content: { markdown: [
        "# 验收范围", "", "| 条件 | 结果 |", "| --- | --- |", "| 登录 | **成功** |", "",
        "3. 确认需求", "4. 下载文档", "   - 子步骤", "", "- [x] 已评审", "- [ ] 待发布", "",
        "**必须验收**、*评审意见*、~~废弃内容~~和`原文代码`。", "",
        "[安全链接](https://example.com/approval) [不安全链接](javascript:alert%281%29)", "",
        "![结构示意图](https://example.com/diagram.png)", "",
        "> 业务引用保留", "", "```text", "const original = '<业务>';", "```",
      ].join("\n") },
    };
    const { archive, document, text } = readDocx((await buildExport(request)).bytes);
    expect(document.getElementsByTagName("w:tbl")).toHaveLength(1);
    expect(document.getElementsByTagName("w:numPr").length).toBeGreaterThanOrEqual(5);
    expect(document.getElementsByTagName("w:hyperlink")).toHaveLength(2);
    for (const literal of ["验收范围", "条件", "结果", "成功", "确认需求", "子步骤", "☑", "☐", "必须验收", "评审意见", "废弃内容", "原文代码", "业务引用保留", "const original = '<业务>';", "[图片：结构示意图]"]) {
      expect(text).toContain(literal);
    }
    expect(text).not.toContain("**必须验收**");
    expect(text).not.toContain("| 条件 | 结果 |");
    for (const [label, tag] of [["必须验收", "w:b"], ["评审意见", "w:i"], ["废弃内容", "w:strike"]]) {
      const run = [...document.getElementsByTagName("w:r")].find((node) => node.textContent === label)!;
      expect(run.getElementsByTagName(tag!)).toHaveLength(1);
    }
    const relationships = strFromU8(archive["word/_rels/document.xml.rels"]!);
    expect(relationships).toContain("https://example.com/approval");
    expect(relationships).not.toContain("javascript:");
    expect(strFromU8(archive["word/numbering.xml"]!)).toContain('w:start w:val="3"');
    expect(Object.keys(archive).filter((name) => name.startsWith("word/media/"))).toHaveLength(0);
  }, 120_000);

  it.each(["docx", "pdf"] as const)("renders a valid PRD v2 document artifact for %s", async (format) => {
    const request = exportRequest(format);
    request.packaging = "single_file";
    const artifact = request.source.artifacts[0]!;
    artifact.kind = "document";
    artifact.schemaVersion = 2;
    artifact.title = prdDocumentV2Example.title;
    artifact.content = structuredClone(prdDocumentV2Example);

    const output = await buildExport(request);

    expect(output.bytes.byteLength).toBeGreaterThan(1_000);
    expect(output.fileName).toBe(`${prdDocumentV2Example.title}.${format}`);
    expect(Buffer.from(output.bytes).subarray(0, format === "docx" ? 2 : 5).toString()).toBe(format === "docx" ? "PK" : "%PDF-");
  }, 120_000);

  it.each(["docx", "pdf"] as const)("exports a fixed ordinary business document as %s", async (format) => {
    const request = exportRequest(format);
    request.packaging = "single_file";
    request.source.artifacts[0] = {
      ...request.source.artifacts[0]!, kind: "document", schemaVersion: 1,
      title: "业务会议纪要", content: { markdown: "# 交付安排\n确认版本后归档，旧版本保持不变。\n\n负责人：产品团队。" },
    };
    const output = await buildExport(request);
    expect(output.fileName).toBe(`业务会议纪要.${format}`);
    if (format === "docx") {
      const { text, archive, document } = readDocx(output.bytes);
      expect(text).toContain("交付安排");
      expect(text).toContain("确认版本后归档，旧版本保持不变。");
      expect(text).toContain("负责人：产品团队。");
      const styles = new JSDOM(strFromU8(archive["word/styles.xml"]!), { contentType: "text/xml" }).window.document;
      for (const name of ["Title", "Heading1", "Heading2"]) {
        const style = [...styles.getElementsByTagName("w:style")].find((node) => node.getAttribute("w:styleId") === name)!;
        expect(style.getElementsByTagName("w:pBdr")).toHaveLength(0);
        expect(style.getElementsByTagName("w:color")[0]?.getAttribute("w:val")).toBe("000000");
      }
      const heading = [...document.getElementsByTagName("w:p")].find((node) => node.textContent === "交付安排")!;
      expect(heading.getElementsByTagName("w:keepNext")[0]?.getAttribute("w:val")).not.toBe("0");
    } else {
      const dir = await mkdtemp(join(tmpdir(), "business-pdf-content-"));
      try {
        const file = join(dir, "output.pdf");
        await writeFile(file, output.bytes);
        const text = execFileSync(process.env.WORKBENCH_PDFTOTEXT_PATH ?? "pdftotext", [file, "-"], { encoding: "utf8" });
        expect(text.replace(/\s+/gu, "")).toContain("确认版本后归档，旧版本保持不变。");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it.each(["docx", "pdf"] as const)("accepts a document-kind artifact and then enforces the PRD v2 protocol for %s", async (format) => {
    const request = exportRequest(format);
    request.packaging = "single_file";
    const artifact = request.source.artifacts[0]!;
    artifact.kind = "document";
    artifact.schemaVersion = 2;
    artifact.title = prdDocumentV2Example.title;
    artifact.content = { ...structuredClone(prdDocumentV2Example), protocol: "workbench.prd.v1" } as never;

    await expect(buildExport(request)).rejects.toMatchObject({
      code: "EXPORT_CONTENT_INVALID",
      safeDetail: "DOCX export only supports PRD v2 or v3",
    });
  });

  it.each([
    ["docx", 0],
    ["docx", 2],
    ["pdf", 0],
    ["pdf", 2],
  ] as const)("rejects %s with %i artifacts instead of silently truncating a release", async (format, count) => {
    const request = exportRequest(format);
    request.packaging = "single_file";
    const artifact = {
      ...request.source.artifacts[0]!,
      kind: "prd" as const,
      schemaVersion: 2,
      content: structuredClone(prdDocumentV2Example),
    };
    request.source.artifacts = Array.from({ length: count }, (_, index) => ({
      ...artifact,
      artifactId: `artifact-${index}`,
      artifactVersionId: `version-${index}`,
    }));

    await expect(buildExport(request)).rejects.toMatchObject({
      code: "EXPORT_CONTENT_INVALID",
      safeDetail: `${format.toUpperCase()} export requires exactly one PRD artifact`,
    });
  });

  it.each(["docx", "pdf"] as const)("rejects %s for a non-PRD selection", async (format) => {
    const request = exportRequest(format);
    request.packaging = "single_file";
    await expect(buildExport(request)).rejects.toMatchObject({ code: "EXPORT_CONTENT_INVALID" });
  });

  it.each([
    { protocol: "workbench.prd.v2" },
    "A regular document is not a PRD",
    null,
    { ...structuredClone(prdDocumentV2Example), sections: {} },
  ])("rejects incomplete and ordinary document content before launching a renderer", async (content) => {
    const request = exportRequest("docx");
    request.packaging = "single_file";
    request.source.artifacts[0]!.kind = "document";
    request.source.artifacts[0]!.content = content as never;
    await expect(buildExport(request)).rejects.toMatchObject({ code: "EXPORT_CONTENT_INVALID" });
  });

  it("rejects a path-traversal diagram id through the full source contract", async () => {
    const request = exportRequest("docx");
    request.packaging = "single_file";
    request.source.artifacts[0]!.kind = "prd";
    const content = structuredClone(prdDocumentV2Example);
    content.sections.businessRequirements.flowAndPages.diagrams[0]!.id = "../escaped";
    request.source.artifacts[0]!.content = content;
    await expect(buildExport(request)).rejects.toMatchObject({
      code: "EXPORT_CONTENT_INVALID",
      safeDetail: "DOCX export requires a complete valid PRD v2 or v3 document",
    });
  });

  it("preserves every block, table cell, relation, history entry, remark and source in DOCX", async () => {
    const request = exportRequest("docx");
    request.packaging = "single_file";
    request.source.artifacts[0]!.kind = "document";
    const content = allContentExample();
    request.source.artifacts[0]!.content = content;
    const output = await buildExport(request);
    const { archive, document, text } = readDocx(output.bytes);
    const compact = (value: string) => value.replace(/\s+/gu, "");
    for (const expected of expectedSourceText(content)) {
      expect(compact(text), `Missing source value: ${expected}`).toContain(compact(expected));
    }
    expect(document.getElementsByTagName("w:tbl").length).toBeGreaterThanOrEqual(11);
    expect(document.getElementsByTagName("a:blip").length).toBeGreaterThanOrEqual(2);
    const bookmarkNames = new Set([...document.getElementsByTagName("w:bookmarkStart")].map((node) => node.getAttribute("w:name")));
    for (const paragraph of [...document.getElementsByTagName("w:p")]) {
      const properties = [...paragraph.children].find((node) => node.tagName === "w:pPr");
      if (!properties) continue;
      expect(paragraph.firstElementChild, "Paragraph properties must precede bookmarks and runs").toBe(properties);
      const tags = [...properties.children].map((node) => node.tagName);
      for (const earlier of ["w:numPr", "w:snapToGrid"]) {
        if (tags.includes(earlier) && tags.includes("w:spacing")) {
          expect(tags.indexOf(earlier), `${earlier} must precede w:spacing`).toBeLessThan(tags.indexOf("w:spacing"));
        }
      }
    }
    for (const link of [...document.getElementsByTagName("w:hyperlink")]) {
      const anchor = link.getAttribute("w:anchor");
      if (anchor) expect(bookmarkNames.has(anchor), `Missing TOC target: ${anchor}`).toBe(true);
    }
    expect(Object.keys(archive).filter((name) => name.startsWith("word/media/"))).toHaveLength(2);
    for (const diagram of content.sections.businessRequirements.flowAndPages.diagrams) {
      for (const edge of diagram.edges) {
        expect(text).toContain(edge.id);
        expect(text).toContain(edge.from);
        expect(text).toContain(edge.to);
      }
    }
    const runs = [...document.getElementsByTagName("w:r")];
    for (const [label, tag] of [
      ["强调文本", "w:b"], ["斜体文本", "w:i"], ["删除标记文本", "w:strike"], ["等宽文本", "w:shd"],
    ]) {
      const run = runs.find((item) => item.textContent === label);
      expect(run?.getElementsByTagName(tag!).length).toBe(1);
    }
    expect(strFromU8(archive["word/_rels/document.xml.rels"]!)).toContain('Target="https://workbench.test/projects/current"');
    expect(text).not.toMatch(/待补充|电子受理单|业务大大名字|更新此内容/u);
    const tables = [...document.getElementsByTagName("w:tbl")];
    const wide = tables.filter((table) => table.textContent?.includes("扩展列1"));
    expect(wide).toHaveLength(2);
    expect(wide[0]?.textContent).toContain("第1行第2列完整内容");
    expect(wide[1]?.textContent).toContain("第2行第6列完整内容");
  }, 120_000);

  it("keeps relative paths readable without creating local file hyperlinks when no web origin is configured", async () => {
    vi.stubEnv("WORKBENCH_WEB_ORIGIN", "");
    const request = exportRequest("docx");
    request.packaging = "single_file";
    request.source.artifacts[0]!.kind = "document";
    request.source.artifacts[0]!.content = allContentExample();
    const { archive, text } = readDocx((await buildExport(request)).bytes);
    expect(text).toContain("业务资料链接");
    expect(text).toContain("/projects/current");
    expect(strFromU8(archive["word/_rels/document.xml.rels"]!)).not.toContain('Target="/projects/current"');
  }, 120_000);

  it("keeps Chinese source text in the generated PDF, including tables and remarks", async () => {
    const request = exportRequest("pdf");
    request.packaging = "single_file";
    request.source.artifacts[0]!.kind = "document";
    const content = allContentExample();
    request.source.artifacts[0]!.content = content;
    const output = await buildExport(request);
    const workDir = await mkdtemp(join(tmpdir(), "prd-pdf-content-"));
    try {
      const input = join(workDir, "output.pdf");
      await writeFile(input, output.bytes);
      // Raw mode preserves each table cell; layout mode preserves paragraphs
      // crossing a page boundary. Check both so extraction order cannot
      // fabricate a missing phrase by interleaving unrelated cells.
      const texts = ["-raw", "-layout"].map((mode) => execFileSync(
        process.env.WORKBENCH_PDFTOTEXT_PATH ?? "pdftotext", [mode, input, "-"], { encoding: "utf8" },
      ));
      const compact = (value: string) => value.replace(/\s+/gu, "");
      for (const expected of expectedSourceText(content)) {
        expect(texts.some((text) => compact(text).includes(compact(expected))),
          `Missing PDF source value: ${expected}`).toBe(true);
      }
      expect(texts.join("\n")).not.toMatch(/待补充|电子受理单|业务大大名字|更新此内容/u);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
