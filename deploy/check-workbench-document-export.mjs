import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  canonicalJson,
  createExportJobRequestSchema,
} from "../packages/workbench-contracts/dist/index.js";
import { buildExport } from "../packages/workbench-export-core/dist/index.js";

const prdDocumentV2Example = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], "utf8"))
  : (await import("../packages/workbench-contracts/dist/prd-example.js")).prdDocumentV2Example;
const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const artifact = {
  position: 0,
  artifactId: "document-export-smoke-artifact",
  artifactVersionId: "document-export-smoke-version",
  kind: "document",
  title: prdDocumentV2Example.title,
  version: 1,
  schemaVersion: 2,
  checksum: digest(prdDocumentV2Example),
  content: prdDocumentV2Example,
  contentMediaType: "application/json",
  assets: [],
};
const { content, contentMediaType, ...pin } = artifact;
const board = {
  id: "document-export-smoke-board",
  projectId: "document-export-smoke-project",
  revision: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
};
const source = {
  releaseId: "document-export-smoke-release",
  projectId: board.projectId,
  releaseVersion: 1,
  boardSnapshot: board,
  manifest: {
    protocol: "workbench.project-release.v1",
    projectId: board.projectId,
    releaseVersion: 1,
    board: { id: board.id, revision: board.revision, checksum: digest(board) },
    artifacts: [pin],
  },
  artifacts: [artifact],
};

for (const [format, mediaType, signature] of [
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK"],
  ["pdf", "application/pdf", "%PDF-"],
]) {
  const command = createExportJobRequestSchema.parse({
    releaseId: source.releaseId,
    format,
    packaging: "single_file",
    selection: {
      kind: "artifact",
      artifactId: artifact.artifactId,
      artifactVersionId: artifact.artifactVersionId,
    },
  });
  const output = await buildExport({ ...command, source });
  assert.equal(output.mediaType, mediaType);
  assert.ok(output.bytes.byteLength > 1_000, `${format} must contain a rendered document`);
  assert.equal(Buffer.from(output.bytes).subarray(0, signature.length).toString(), signature);
  console.log(`${format} document export passed (${output.bytes.byteLength} bytes)`);
}
