import { describe, expect, it } from "vitest";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import { prdDocumentV3Schema, prdTableOfContentsEntriesForV3 } from "@workbench/workbench-contracts";
import { unzipSync, strFromU8 } from "fflate";
import { JSDOM } from "jsdom";
import { buildExport } from "../src/index.js";
import { exportRequest } from "./fixtures.js";

function functionalDocument(kinds: readonly string[]) {
  const document = structuredClone(prdDocumentV3Example);
  const diagrams = document.sections.businessRequirements.functionSections.flatMap((section) => section.diagrams)
    .filter((diagram) => kinds.includes(diagram.kind))
    .map((diagram, index) => ({ ...diagram, title: `图${index + 1} ${diagram.kind === "productFlow" ? "产品流程图" : "产品架构图"}` }));
  document.sections.businessRequirements.functionSections = [{
    id: "function-task", title: "2.2 任务提交与结果核验",
    blocks: document.sections.businessRequirements.functionSections.flatMap((section) => section.blocks), diagrams,
  }];
  document.tableOfContents.entries = prdTableOfContentsEntriesForV3(["2.2 任务提交与结果核验"]);
  return prdDocumentV3Schema.parse(document);
}

describe("Function-based PRD exports", () => {
  it.each([[], ["productFlow"], ["productArchitecture"], ["productFlow", "productArchitecture"]].map((kinds) => ({ kinds })))(
    "renders actual section headings and the independently selected diagrams: $kinds", async ({ kinds }) => {
      const document = functionalDocument(kinds);
      const request = exportRequest("html");
      request.packaging = "single_file";
      request.source.artifacts[0] = { ...request.source.artifacts[0]!, kind: "prd", schemaVersion: 3, title: document.title, content: document };
      const html = new TextDecoder().decode((await buildExport(request)).bytes);
      const parsed = new JSDOM(html).window.document;
      expect([...parsed.querySelectorAll("h3")].map((node) => node.textContent)).toContain("2.2 任务提交与结果核验");
      expect(parsed.querySelectorAll(".wb-prd__diagram")).toHaveLength(kinds.length);
      expect(html).not.toContain("2.3 核心流程/状态/页面要求");
    },
  );

  it("exports a single function with embedded acceptance and no diagram in black and white", async () => {
    const document = functionalDocument([]);
    const request = exportRequest("docx");
    request.packaging = "single_file";
    request.source.artifacts[0] = { ...request.source.artifacts[0]!, kind: "prd", schemaVersion: 3, title: document.title, content: document };
    const archive = unzipSync((await buildExport(request)).bytes);
    const xml = new JSDOM(strFromU8(archive["word/document.xml"]!), { contentType: "text/xml" }).window.document;
    const text = [...xml.getElementsByTagName("w:t")].map((node) => node.textContent).join("");
    expect(text).toContain("2.2 任务提交与结果核验");
    expect(text).toContain("验收标准");
    expect(xml.getElementsByTagName("w:drawing")).toHaveLength(0);
    expect(xml.getElementsByTagName("w:tblpPr")).toHaveLength(0);
    for (const [name, bytes] of Object.entries(archive)) {
      if (!name.startsWith("word/") || !name.endsWith(".xml")) continue;
      const part = new JSDOM(strFromU8(bytes), { contentType: "text/xml" }).window.document;
      for (const color of part.getElementsByTagName("w:color")) expect(color.getAttribute("w:val")).toBe("000000");
      for (const shade of part.getElementsByTagName("w:shd")) expect(shade.getAttribute("w:fill")).toBe("FFFFFF");
      expect(part.getElementsByTagName("w:highlight")).toHaveLength(0);
    }
  });
});
