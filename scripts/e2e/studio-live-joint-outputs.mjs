import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson, prototypeDocumentSchema } from "@workbench/workbench-contracts";
import { auditPrd } from "./studio-live-prd-artifacts.mjs";

const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");

async function verifyChannelRows(frame) {
  const select = frame.getByRole("combobox", { name: "渠道类型", exact: true });
  const buttons = frame.getByRole("button", { name: "查看详情", exact: true });
  async function selectAndRead(label) {
    await select.selectOption({ label });
    return buttons.evaluateAll(items => items.map(button => {
      // Tables and free-positioned canvas rows are both supported. Choose a
      // row containing only this detail action, falling back to its node ID.
      let row = button;
      while (row.parentElement && items.filter(other => row.parentElement.contains(other)).length === 1) row = row.parentElement;
      const text = row.innerText.replace(/查看详情/gu, "").trim();
      return text || button.closest("[data-wb-node]")?.dataset.wbNode;
    }));
  }
  const all = await selectAndRead("全部");
  const wecom = await selectAndRead("企微");
  const sms = await selectAndRead("短信");
  assert.equal(wecom.length, 2);
  assert.equal(sms.length, 2);
  assert.ok(all.length === 4 && all.every(Boolean) && new Set(all).size === 4, "Four identifiable activities must be visible with all channels selected");
  assert.equal(hash([...wecom, ...sms].sort()), hash([...all].sort()), "The two channel filters must partition the original four rows");
  await select.selectOption({ label: "全部" });
  return { all: all.length, wecom: wecom.length, sms: sms.length, distinctRowSets: true };
}

export async function auditJointOutputs(query, api, scenario, frame) {
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
  const events = await query("SELECT sequence,payload->>'artifactVersionId' AS version_id FROM workbench.run_events WHERE run_id=$1 AND type='artifact.draft.created' ORDER BY sequence", [scenario.runId]);
  const prdSequence = events.find(x => x.version_id === prd.id)?.sequence;
  const prototypeSequence = events.find(x => x.version_id === prototype.id)?.sequence;
  assert.ok(prdSequence > 0 && prototypeSequence > prdSequence, "The linked PRD version must materialize before its prototype");
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
  const channelRows = await verifyChannelRows(frame);
  const [prdRelations, prototypeRelations] = await Promise.all(
    [prd, prototype].map(output => api("GET", `/artifacts/${output.artifact_id}/versions/${output.id}/relations`)),
  );
  const prototypes = prdRelations.body?.derivedPrototypes;
  const derived = Array.isArray(prototypes) ? prototypes.find(item => item.artifactVersionId === prototype.id) : undefined;
  const relations = {
    prdResponseStatus: prdRelations.status,
    prototypeResponseStatus: prototypeRelations.status,
    prdListsGeneratedPrototype: derived?.createdByRunId === scenario.runId && derived?.prototypeRevision?.id === revision.id,
    prototypePointsToGeneratedPrd: prototypeRelations.body?.sourcePrd?.artifactVersionId === prd.id
      && prototypeRelations.body?.sourcePrd?.createdByRunId === scenario.runId,
  };
  const { requirements } = documentAudit;
  const observed = scenario.activityInteraction;
  const prdBody = canonicalJson(prd.content.sections);
  const commonFacts = {
    defaultChannel: {
      prdAllOptionEvidenceSha256: hash(requirements.all),
      prdMentionsAllAsDefault: /默认[^。！？]{0,24}全部|全部[^。！？]{0,12}默认/u.test(prdBody),
      prototype: observed.defaultChannel,
    },
    wecomChannel: { prdEvidenceSha256: hash(requirements.channels), prototypeVisibleRows: observed.channelRowCounts.企微 },
    smsChannel: { prdEvidenceSha256: hash(requirements.sms), prototypeVisibleRows: observed.channelRowCounts.短信 },
    emptyResult: { prdEvidenceSha256: hash(requirements.empty), prototypeShowsEmptyMessage: observed.emptySearchShowsMessage },
  };
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
    releaseId: run.knowledge_release_id, firstDraftEvent: { prd: prdSequence, prototype: prototypeSequence }, channelRows, relations, commonFacts,
    prd: { versionId: prd.id, version: prd.version, sha256: prd.checksum, citations: prd.citations.map(x => x.id), semanticChecks: Object.keys(requirements) },
    prototype: { versionId: prototype.id, version: prototype.version, sha256: prototype.checksum, revisionId: revision.id, sourcePrdVersionId: prototype.source_prd_version_id, citations: prototype.citations.map(x => x.id), screenCount: doc.screens.length, interactive: scenario.finalInteraction },
  };
}
