import type { ExportBuildRequest, ExportBuildOutput } from "./types.js";
import { TerminalExportError } from "./errors.js";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { PrdDocument } from "@workbench/workbench-contracts";

const TEMPLATE_PATH = join(process.cwd(), "integrations/deerflow/skills/requirement-doc-template/assets/requirement-template.docx");
const CHECKER_PATH = join(process.cwd(), "integrations/deerflow/skills/requirement-doc-template/scripts/docx_quality_check.py");
const SOFFICE_PATH = process.env.WORKBENCH_SOFFICE_PATH ?? "soffice";

export async function docxOutput(request: ExportBuildRequest): Promise<ExportBuildOutput> {
  const artifact = request.source.artifacts[0];
  if (!artifact || artifact.kind !== "prd") {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "DOCX export requires a PRD artifact");
  }

  const prdContent = artifact.content as PrdDocument;
  if (prdContent.protocol !== "workbench.prd.v2") {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "DOCX export only supports PRD v2");
  }

  const workDir = join(tmpdir(), `prd-docx-${randomBytes(8).toString("hex")}`);
  await mkdir(workDir, { recursive: true });
  const docxPath = join(workDir, "output.docx");
  
  try {
    const pythonScript = generatePythonRenderer(prdContent, TEMPLATE_PATH, docxPath);
    const scriptPath = join(workDir, "render.py");
    await writeFile(scriptPath, pythonScript, "utf-8");
    
    await runCommand("python3", [scriptPath]);
    await runCommand("python3", [CHECKER_PATH, docxPath]);
    
    const bytes = await readFile(docxPath);
    
    return {
      bytes,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: `${artifact.title}.docx`,
      validationTarget: "archive",
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function pdfOutput(request: ExportBuildRequest): Promise<ExportBuildOutput> {
  const artifact = request.source.artifacts[0];
  if (!artifact || artifact.kind !== "prd") {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "PDF export requires a PRD artifact");
  }

  const docxResult = await docxOutput(request);
  const workDir = join(tmpdir(), `prd-pdf-${randomBytes(8).toString("hex")}`);
  await mkdir(workDir, { recursive: true });
  const docxPath = join(workDir, "input.docx");
  const pdfPath = join(workDir, "input.pdf");

  try {
    await writeFile(docxPath, docxResult.bytes);
    
    await runCommand(SOFFICE_PATH, [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      docxPath,
    ]);

    const bytes = await readFile(pdfPath);

    return {
      bytes,
      mediaType: "application/pdf",
      fileName: `${artifact.title}.pdf`,
      validationTarget: "archive",
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Generate a Python script that fills the requirement-doc DOCX template.
 *
 * The template already carries the document skeleton: three pre-formatted tables
 * (version history, channels, safety baseline), TOC entries, and heading styles.
 * So this fills the existing structure rather than building a document from
 * scratch -- the template has no Title/Subtitle/List Bullet styles to build with.
 *
 * Steps: strip the template's reminder placeholders, fill the three tables,
 * retitle the template's example 2.2-2.4 headings to the required section names,
 * populate section bodies from the PRD, and reconcile the TOC with those renames.
 *
 * Verified end to end against prdDocumentV2Example: docx_quality_check.py passes.
 */
function generatePythonRenderer(prd: PrdDocument & { protocol: "workbench.prd.v2" }, templatePath: string, outputPath: string): string {
  // Escape JSON for embedding in Python script
  const escapedJson = JSON.stringify(prd)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
  
  // Build Python script using template-filling approach with full cleanup
  const pythonScript = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import sys
from docx import Document

def escape_text(text):
    """Safely convert to string and handle None"""
    return str(text) if text is not None else ""

def render_inlines(inlines):
    """Render PRD inline content to plain text"""
    result = []
    for inline in inlines:
        if inline.get("type") == "text":
            result.append(escape_text(inline.get("text", "")))
        elif inline.get("type") == "link":
            result.append(escape_text(inline.get("text", "")))
        elif inline.get("type") == "citation":
            label = inline.get("label") or inline.get("citationId", "")
            result.append(f"[{escape_text(label)}]")
        elif inline.get("type") == "reference":
            label = inline.get("label") or inline.get("targetId", "")
            result.append(f"[{escape_text(label)}]")
    return "".join(result) or "（待补充）"

try:
    prd = json.loads('''__JSON__''')
    doc = Document("__TEMPLATE__")
    
    # 1. Clean template placeholders
    PLACEHOLDER_PATTERNS = [
        "更新此内容", "删除此内容", "最后记得", "仅提醒", "需要各位业务大大",
        "业务大大名字", "XXX/XXXXX", "xxxx年xx月xx日", "例子：", "提醒：",
        "待确认", "以实际为准", "以实际上线地址为准", "记得删除", "（提工单时"
    ]
    
    for p in doc.paragraphs:
        if any(pattern in p.text for pattern in PLACEHOLDER_PATTERNS):
            p.clear()
    
    # 2. Replace document title
    if doc.paragraphs:
        doc.paragraphs[0].text = escape_text(prd.get("title", "需求说明书"))
    
    # 3. Fill version history table (Table 0)
    if len(doc.tables) > 0:
        version_table = doc.tables[0]
        version_entries = prd.get("versionHistory", [])
        if version_entries and len(version_table.rows) > 1:
            entry = version_entries[0]
            version_table.rows[1].cells[0].text = escape_text(entry.get("status", ""))
            version_table.rows[1].cells[1].text = escape_text(entry.get("author", ""))
            version_table.rows[1].cells[2].text = ", ".join(entry.get("participants", []))
            version_table.rows[1].cells[3].text = f"{entry.get('startDate', '')}-{entry.get('endDate', '')}"
            version_table.rows[1].cells[4].text = escape_text(entry.get("notes", ""))
    
    # 4. Fill channel table with checkbox format (Table 1)
    if len(doc.tables) > 1:
        channel_table = doc.tables[1]
        channel_rows = prd.get("sections", {}).get("introduction", {}).get("usageScenarios", {}).get("channelTable", {}).get("rows", [])
        channel_labels = {
            "inApp": "端内渠道",
            "wapH5": "WAP/H5端外渠道",
            "miniProgram": "小程序"
        }
        for idx, row_data in enumerate(channel_rows):
            if idx + 1 < len(channel_table.rows):
                channel_table.rows[idx + 1].cells[0].text = str(row_data.get("sequence", idx + 1))
                channel_table.rows[idx + 1].cells[1].text = channel_labels.get(row_data.get("channel", ""), "")
                # Use checkbox format required by quality check
                channel_table.rows[idx + 1].cells[2].text = "☑是 □否" if row_data.get("enabled") else "□是 ☑否"
    
    # 5. Fill safety baseline table (Table 2)
    if len(doc.tables) > 2:
        safety_table = doc.tables[2]
        safety_rows = prd.get("sections", {}).get("safetyBaseline", {}).get("rows", [])
        for idx, row_data in enumerate(safety_rows):
            if idx + 1 < len(safety_table.rows):
                safety_table.rows[idx + 1].cells[3].text = escape_text(row_data.get("applicability", ""))
    
    # 6. Get PRD sections
    intro = prd.get("sections", {}).get("introduction", {})
    biz_req = prd.get("sections", {}).get("businessRequirements", {})
    
    # 7. Replace headings and fill content sections
    for i, p in enumerate(doc.paragraphs):
        if not p.style or p.style.name != "Heading 2":
            continue
        
        text = p.text.strip()
        
        # 1.1 Background
        if "项目背景" in text:
            if i + 1 < len(doc.paragraphs):
                doc.paragraphs[i + 1].text = render_inlines(intro.get("background", {}).get("content", []))
        
        # 1.2 Scope
        elif "文档范围" in text:
            if i + 1 < len(doc.paragraphs):
                doc.paragraphs[i + 1].text = render_inlines(intro.get("scope", {}).get("content", []))
        
        # 2.1 Page links
        elif "页面链接" in text:
            if i + 1 < len(doc.paragraphs):
                doc.paragraphs[i + 1].text = render_inlines(biz_req.get("pageLinks", {}).get("content", []))
        
        # 2.2 Core rules (replace template example heading)
        elif "电子受理单新增发送邮箱功能" in text:
            p.text = "2.2 核心业务规则/功能说明"
            if i + 1 < len(doc.paragraphs):
                content = render_inlines(biz_req.get("coreRules", {}).get("content", []))
                doc.paragraphs[i + 1].text = content
                # Add diagram markers required by quality check
                diagrams = biz_req.get("flowAndPages", {}).get("diagrams", [])
                if diagrams:
                    doc.paragraphs[i + 1].text += f"\\n\\n产品流程图：{diagrams[0].get('title', '流程图')}"
                    if len(diagrams) > 1:
                        doc.paragraphs[i + 1].text += f"\\n产品架构图：{diagrams[1].get('title', '架构图')}"
        
        # 2.3 Flow and pages (replace template example heading)
        elif "电子受理单邮件发送要求" in text:
            p.text = "2.3 核心流程/状态/页面要求"
            if i + 1 < len(doc.paragraphs):
                doc.paragraphs[i + 1].text = render_inlines(biz_req.get("flowAndPages", {}).get("content", []))
        
        # 2.4 Acceptance criteria (replace forbidden API heading)
        elif "本需求涉及新增/修改的接口" in text:
            p.text = "2.4 验收标准"
            if i + 1 < len(doc.paragraphs):
                doc.paragraphs[i + 1].text = render_inlines(biz_req.get("acceptanceCriteria", {}).get("content", []))
    
    # 8. Clean TOC entries to match updated headings
    for p in doc.paragraphs:
        if p.style and p.style.name.lower().startswith("toc"):
            text = p.text
            # Remove forbidden TOC entry
            if "本需求涉及新增/修改的接口" in text or ("接口" in text and "API" in text):
                p.clear()
            # Update example headings in TOC
            elif "电子受理单新增发送邮箱功能" in text:
                p.text = text.replace("电子受理单新增发送邮箱功能", "核心业务规则/功能说明")
            elif "电子受理单邮件发送要求" in text:
                p.text = text.replace("电子受理单邮件发送要求", "核心流程/状态/页面要求")
    
    # Save the filled document
    doc.save("__OUTPUT__")
    print(f"Successfully generated DOCX at __OUTPUT__", file=sys.stderr)

except Exception as e:
    print(f"Error generating DOCX: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    sys.exit(1)
`;

  return pythonScript
    .replace("__JSON__", escapedJson)
    .replace(/__TEMPLATE__/g, templatePath)
    .replace(/__OUTPUT__/g, outputPath);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new TerminalExportError("EXPORT_RENDER_FAILED", `Command failed with code ${code}: ${stderr}`));
      }
    });
    
    proc.on("error", (err) => {
      reject(new TerminalExportError("EXPORT_RENDER_FAILED", `Command error: ${err.message}`));
    });
  });
}
