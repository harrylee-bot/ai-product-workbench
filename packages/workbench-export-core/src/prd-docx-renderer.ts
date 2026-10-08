import type { ExportBuildRequest, ExportBuildOutput, ExportBuildExecution } from "./types.js";
import { TerminalExportError } from "./errors.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { businessDocumentSchema, prdDocumentV2Schema } from "@workbench/workbench-contracts";
import { runDocumentExportCommand } from "./document-export-command.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const workspaceRoot = existsSync(join(process.cwd(), "integrations"))
  ? process.cwd()
  : existsSync(join(process.cwd(), "../../integrations"))
    ? join(process.cwd(), "../..")
    : process.cwd();
const TEMPLATE_PATH = join(workspaceRoot, "integrations/deerflow/skills/requirement-doc-template/assets/requirement-template.docx");
const CHECKER_PATH = join(workspaceRoot, "integrations/deerflow/skills/requirement-doc-template/scripts/docx_quality_check.py");
const SOFFICE_PATH = process.env.WORKBENCH_SOFFICE_PATH ?? "soffice";
const PYTHON_PATH = process.env.WORKBENCH_EXPORT_PYTHON_PATH ?? "python3";
const RENDERER_PATH = fileURLToPath(new URL("../scripts/render_prd_docx.py", import.meta.url));
const DOCUMENT_RENDERER_PATH = fileURLToPath(new URL("../scripts/render_business_docx.py", import.meta.url));

export async function docxOutput(request: ExportBuildRequest, execution: ExportBuildExecution = {}): Promise<ExportBuildOutput> {
  execution.signal?.throwIfAborted();
  const artifact = request.source.artifacts[0];
  if (request.source.artifacts.length !== 1
    || !artifact
    || (artifact.kind !== "prd" && artifact.kind !== "document")) {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "DOCX export requires exactly one PRD artifact");
  }

  const businessDocument = artifact.kind === "document" ? businessDocumentSchema.safeParse(artifact.content) : null;
  if (!businessDocument?.success && (!artifact.content || typeof artifact.content !== "object"
    || !("protocol" in artifact.content) || artifact.content.protocol !== "workbench.prd.v2")) {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "DOCX export only supports PRD v2");
  }
  const parsed = prdDocumentV2Schema.safeParse(artifact.content);
  if (!parsed.success && !businessDocument?.success) {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "DOCX export requires a complete valid PRD v2 document");
  }

  const workDir = join(tmpdir(), `prd-docx-${randomBytes(8).toString("hex")}`);
  await mkdir(workDir, { recursive: true });
  const docxPath = join(workDir, "output.docx");
  
  try {
    const sourcePath = join(workDir, "source.json");
    if (businessDocument?.success) {
      const markdown = "markdown" in businessDocument.data ? businessDocument.data.markdown : undefined;
      await writeFile(sourcePath, JSON.stringify({
        ...businessDocument.data,
        title: artifact.title,
        ...(markdown === undefined ? {} : {
          markdownAst: fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
        }),
      }), "utf-8");
      await runDocumentExportCommand(PYTHON_PATH, [DOCUMENT_RENDERER_PATH, "--source", sourcePath, "--output", docxPath], execution);
    } else if (parsed.success) {
      await writeFile(sourcePath, JSON.stringify(parsed.data), "utf-8");
      await runDocumentExportCommand(PYTHON_PATH, [RENDERER_PATH, "--source", sourcePath, "--template", TEMPLATE_PATH, "--output", docxPath], execution);
      await runDocumentExportCommand(PYTHON_PATH, [CHECKER_PATH, docxPath], execution);
    }
    
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
export async function pdfOutput(request: ExportBuildRequest, execution: ExportBuildExecution = {}): Promise<ExportBuildOutput> {
  const artifact = request.source.artifacts[0];
  if (request.source.artifacts.length !== 1
    || !artifact
    || (artifact.kind !== "prd" && artifact.kind !== "document")) {
    throw new TerminalExportError("EXPORT_CONTENT_INVALID", "PDF export requires exactly one PRD artifact");
  }

  const docxResult = await docxOutput(request, execution);
  const workDir = join(tmpdir(), `prd-pdf-${randomBytes(8).toString("hex")}`);
  await mkdir(workDir, { recursive: true });
  const docxPath = join(workDir, "input.docx");
  const pdfPath = join(workDir, "input.pdf");

  try {
    await writeFile(docxPath, docxResult.bytes);
    
    await runDocumentExportCommand(SOFFICE_PATH, [
      `-env:UserInstallation=${pathToFileURL(join(workDir, "libreoffice-profile")).href}`,
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      docxPath,
    ], execution);

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
