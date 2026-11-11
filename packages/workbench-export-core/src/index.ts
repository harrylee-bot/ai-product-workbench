import type { ExportFormat } from "@workbench/workbench-contracts";
import { TerminalExportError } from "./errors.js";
import { figmaOutput } from "./figma-export.js";
import { htmlOutput, htmlZipOutput, selectExportArtifacts } from "./html-renderer.js";
import { sourcePrototypeReactOutput } from "./source-prototype.js";
import { mcpOutput } from "./mcp-export.js";
import { docxOutput, pdfOutput } from "./prd-docx-renderer.js";
import { reactOutput } from "./react-export.js";
import type { ExportBuildRequest, ExportBuildOutput, ExportBuildExecution } from "./types.js";

export * from "./archive.js";
export * from "./errors.js";
export * from "./figma-export.js";
export * from "./html-renderer.js";
export * from "./prd-docx-renderer.js";
export * from "./types.js";
export * from "./source-prototype.js";

const allowedOptions: Record<ExportFormat, ReadonlySet<string>> = {
  html: new Set(),
  react: new Set(["packageName"]),
  mcp: new Set(["serverName"]),
  figma: new Set(),
  docx: new Set(),
  pdf: new Set(),
};

export async function buildExport(request: ExportBuildRequest, execution: ExportBuildExecution = {}): Promise<ExportBuildOutput> {
  execution.signal?.throwIfAborted();
  assertOptions(request);
  const selected = selectExportArtifacts(request.source.artifacts, request.selection, request.source.boardSnapshot.nodes);
  const source = selected.find((artifact) => artifact.kind === "prototype" && artifact.schemaVersion === 2);
  if (source) {
    if (selected.length !== 1 || request.selection.kind !== "artifact") throw new TerminalExportError("SOURCE_PROTOTYPE_SELECTION_UNSUPPORTED", "Source prototypes require one fixed ArtifactVersion selection");
    if (request.selection.screenId !== undefined || request.initialScreenId !== undefined) throw new TerminalExportError("SOURCE_PROTOTYPE_SCREEN_SELECTION_UNSUPPORTED", "Source prototype navigation belongs to its React application");
    if (request.format !== "html" && request.format !== "react") throw new TerminalExportError("SOURCE_PROTOTYPE_FORMAT_UNSUPPORTED", "Source prototypes currently support HTML and React source exports");
    if (request.format === "react") {
      if (request.packaging !== "zip") throw new TerminalExportError("EXPORT_PACKAGING_UNSUPPORTED", "React source exports require zip packaging");
      return sourcePrototypeReactOutput(source, request.options.packageName);
    }
  }
  if (request.format === "html") {
    return request.packaging === "zip" ? htmlZipOutput(request) : htmlOutput(request);
  }
  if (request.format === "docx" || request.format === "pdf") {
    if (request.packaging !== "single_file") {
      throw new TerminalExportError(
        "EXPORT_PACKAGING_UNSUPPORTED",
        `${request.format} exports require single_file packaging`,
      );
    }
    return request.format === "docx" ? docxOutput(request, execution) : pdfOutput(request, execution);
  }
  if (request.packaging !== "zip") {
    throw new TerminalExportError("EXPORT_PACKAGING_UNSUPPORTED", `${request.format} exports require zip packaging`);
  }
  if (request.format === "react") return reactOutput(request);
  if (request.format === "mcp") return mcpOutput(request);
  if (request.format === "figma") return figmaOutput(request);
  throw new TerminalExportError("EXPORT_FORMAT_UNSUPPORTED", "Unsupported Export format");
}

function assertOptions(request: ExportBuildRequest) {
  const allowed = allowedOptions[request.format];
  const unknown = Object.keys(request.options).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TerminalExportError(
      "EXPORT_OPTIONS_UNSUPPORTED",
      `Unsupported ${request.format} export option(s): ${unknown.sort().join(", ")}`,
    );
  }
}
