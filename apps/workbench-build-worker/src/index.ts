import { createHash } from "node:crypto";
import { prototypePageSchema, type PrototypePage } from "@workbench/workbench-contracts";
import { renderPrototypePagesHtml, type ExportBinaryAsset } from "@workbench/workbench-export-core";
import { checkFrozenPrototypeHtml } from "./browser-check.js";

export type PrototypeBuildArtifact = {
  document: { revisionId: string; title: string; pages: PrototypePage[] };
  html: string;
  htmlSha256: string;
  byteSize: number;
};

export type PrototypeBuildWorkerOptions = {
  chromiumExecutablePath?: string;
  browserTimeoutMs?: number;
  requireBrowserCheck?: boolean;
  onProgress?: (details: string) => void;
  sourceDocument?: unknown;
  assets?: ExportBinaryAsset[];
};

export async function buildFrozenPrototypeHtml(
  revisionId: string,
  title: string,
  pages: readonly PrototypePage[],
  options: PrototypeBuildWorkerOptions = {},
): Promise<PrototypeBuildArtifact> {
  const parsed = pages.map((page) => prototypePageSchema.parse(page));
  const html = renderPrototypePagesHtml(revisionId, title, parsed, options.sourceDocument ? { document: options.sourceDocument, assets: options.assets } : undefined);
  if (options.requireBrowserCheck !== false) {
    await checkFrozenPrototypeHtml(html, {
      executablePath: options.chromiumExecutablePath,
      timeoutMs: options.browserTimeoutMs,
      onProgress: options.onProgress,
    });
  }
  return { document: { revisionId, title, pages: parsed }, html, htmlSha256: sha256(html), byteSize: Buffer.byteLength(html, "utf8") };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export { checkFrozenPrototypeHtml } from "./browser-check.js";
