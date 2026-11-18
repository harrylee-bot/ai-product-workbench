import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson, prototypeDocumentSchema } from "@workbench/workbench-contracts";
import { auditPrd } from "./studio-live-prd-artifacts.mjs";

const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");

export async function auditJointOutputs(query, scenario) {
  const [frozen] = await query("SELECT * FROM workbench.requirement_confirmations WHERE id=$1", [scenario.confirmationId]);
  const [run] = await query("SELECT request, status, model_id, knowledge_release_id FROM workbench.runs WHERE id=$1", [scenario.runId]);
  assert.equal(run.status, "succeeded");
  assert.equal(run.model_id, "deepseek-flash");
  assert.equal(hash(run.request), hash(frozen.generation_request));
  assert.equal(run.knowledge_release_id, frozen.input_snapshot.knowledgeReleaseId);
  assert.deepEqual(run.request.outputOperations.map(x => x.kind), ["prd", "prototype"]);
  const [prd, prototype] = await query(
    "SELECT a.kind,v.* FROM workbench.artifact_versions v JOIN workbench.artifacts a ON a.id=v.artifact_id WHERE v.created_by_run_id=$1 AND v.status='ready' ORDER BY v.runtime_draft_index",
    [scenario.runId],
  );
  assert.ok(prd?.kind === "prd" && prototype?.kind === "prototype");
  assert.equal(prd.runtime_draft_index, 0);
  assert.equal(prototype.runtime_draft_index, 1);
  assert.equal(prototype.source_prd_version_id, prd.id);
  for (const output of [prd, prototype]) {
    assert.equal(output.knowledge_release_id, run.knowledge_release_id);
    assert.equal(output.checksum, hash(output.content));
  }
  const documentAudit = await auditPrd({ query, artifact: prd, frozen });
  const doc = prototypeDocumentSchema.parse(prototype.content);
  const [revision] = await query("SELECT id,source_artifact_version_id,source_document FROM workbench.prototype_revisions WHERE plan_id=$1 AND source_artifact_version_id=$2", [scenario.planId, prototype.id]);
  assert.equal(revision?.source_artifact_version_id, prototype.id);
  assert.equal(hash(revision.source_document), hash(prototype.content));
  assert.equal(doc.screens.length, 2, "Confirmed scope includes only the activity list and activity detail");
  // The browser also executes channel/empty/search/detail/back interactions.
  assert.ok(scenario.finalInteraction);
  const published = JSON.parse(await readFile(process.env.WORKBENCH_STUDIO_LIVE_PUBLISHED_KNOWLEDGE, "utf8"));
  const citations = [...frozen.baseline.evidence, ...prd.citations, ...prototype.citations];
  const lookedUp = new Set(scenario.retrievals.flatMap(x => x.citationIds));
  for (const c of [...prd.citations, ...prototype.citations]) assert.ok(lookedUp.has(c.id), "Output cites a chunk returned by the generating Run");
  for (const c of citations) {
    const [row] = await query("SELECT c.content,d.metadata FROM workbench.knowledge_chunks c JOIN workbench.knowledge_documents d ON d.id=c.document_id AND d.release_id=c.release_id WHERE c.id=$1 AND c.document_id=$2 AND c.release_id=$3", [c.chunkId,c.documentId,run.knowledge_release_id]);
    assert.ok(row && c.quote && row.content.includes(c.quote));
    assert.equal(row.metadata.copiedFromPublishedRelease.id, published.release.id);
    assert.ok(published.chunks.some(original => original.document_id === row.metadata.originalDocumentId && original.source_path === c.sourcePath && original.content.includes(row.content)));
  }
  return {
    runId: scenario.runId, planId: scenario.planId, confirmationId: frozen.id, summaryChecksum: frozen.baseline.summaryChecksum,
    publishedReleaseId: published.release.id, publishedSourceVersion: published.release.version,
    releaseId: run.knowledge_release_id, prd: { versionId: prd.id, version: prd.version, sha256: prd.checksum, citations: prd.citations.map(x => x.id), semanticChecks: Object.keys(documentAudit.requirements) },
    prototype: { versionId: prototype.id, version: prototype.version, sha256: prototype.checksum, revisionId: revision.id, sourcePrdVersionId: prototype.source_prd_version_id, citations: prototype.citations.map(x => x.id), screenCount: doc.screens.length, interactive: scenario.finalInteraction },
  };
}
