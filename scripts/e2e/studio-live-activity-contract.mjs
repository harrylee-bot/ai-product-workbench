import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const name = "活动列表查询接口（本地验收样本）.md";
const text = [
  "# 云溪营销极速发布平台 · 活动列表查询接口",
  "",
  "这份接口合同只适用于本地验收的虚构项目，不描述任何线上项目。",
  "",
  "## 现有查询",
  "活动管理列表复用 GET /api/activities。keyword、page、pageSize 的现有语义保持不变。",
  "服务端先限制到当前策划人员已授权的区域，再应用筛选和分页。未授权区域的记录不得出现在列表、总数或搜索结果中。",
  "正常响应按原有分页契约返回活动和总数。空列表走原有成功响应。请求失败时保留查询条件，并允许用户原地重试同一请求。",
  "",
  "## 本次确认的查询参数扩展",
  "可选查询参数 channelType。默认「全部」时省略 channelType，不传 all。企微传 wecom，短信传 sms。",
  "历史活动的渠道值可能为空，只有「全部」可以看到这些记录，且仍需通过所属区域的授权检查。",
  "改变渠道时保留其他查询条件并回到第 1 页。筛选结果为空时显示「无匹配活动」。重试沿用当前查询条件和渠道。",
  "不新增接口、外部系统、角色或页面。不改变登录、导航、审核发布、报表、已有数据库列或分页实现。",
  "",
].join("\n");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function attachStudioActivityContract({ page, webOrigin, projectId, query, waitUntil }) {
  const studio = `${webOrigin}/studio/${projectId}`;
  const bytes = Buffer.from(text);
  await page.goto(studio + "?view=resources");
  await page.getByLabel("项目资料文件", { exact: true }).setInputFiles({ name, mimeType: "text/markdown", buffer: bytes });
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  const row = await waitUntil(async () => {
    const [source] = await query(
      `SELECT s.id AS source_id,s.checksum,m.blob_id,bs.scanner,bs.status AS scan,e.status AS extraction_status,e.parser_version
       FROM workbench.import_sources s
       JOIN workbench.import_source_blobs m ON m.import_source_id=s.id
       JOIN workbench.file_assets f ON f.id=m.file_asset_id
       JOIN workbench.blob_scans bs ON bs.blob_id=f.blob_id
       JOIN workbench.file_extractions e ON e.id=f.current_extraction_id
       WHERE s.project_id=$1 AND s.label=$2 AND s.status='ready'`,
      [projectId, name],
    );
    const alerts = await page.getByRole("region", { name: "项目文件" }).getByRole("alert").count();
    if (!source && alerts) throw Object.assign(new Error("Contract attachment processing failed"), { fatal: true });
    return source;
  }, "Project contract upload, scan and extraction", 120000);
  assert.equal(row.checksum, sha256(bytes));
  assert.equal(row.scanner, "clamav");
  assert.equal(row.scan, "clean");
  assert.equal(row.extraction_status, "ready");
  assert.match(row.parser_version, /docling-serve/u);
  await page.goto(studio);
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByRole("checkbox", { name: name + " · ready", exact: true }).check();
  return { name, sourceId: row.source_id, blobId: row.blob_id, sha256: row.checksum, scanner: row.scanner, parser: row.parser_version };
}

export async function auditStudioActivityContract({ query, source, frozen }) {
  assert.ok(frozen.generation_request.sourceIds.includes(source.sourceId));
  const snapshot = frozen.input_snapshot.sources.find(item => item.sourceId === source.sourceId);
  assert.ok(snapshot?.snapshot.blobs.some(blob => blob.blobId === source.blobId && blob.sha256 === source.sha256));
  const analyzedOriginalSha256 = verifyOriginal(source, frozen.baseline.sourceContents.readings);
  const [persisted] = await query(
    `SELECT checksum,snapshot FROM workbench.run_source_snapshots
      WHERE run_id=$1 AND project_id=$2 AND source_id=$3`,
    [frozen.run_id, frozen.project_id, source.sourceId],
  );
  assert.equal(persisted?.checksum, source.sha256);
  assert.ok(persisted.snapshot.blobs.some(blob => blob.blobId === source.blobId && blob.sha256 === source.sha256));
  assert.ok(frozen.baseline.evidence.length && frozen.input_snapshot.knowledgeReleaseId);
  return { ...source, analyzedOriginalSha256, frozenInRun: true, pinnedPublishedKnowledgeId: frozen.input_snapshot.knowledgeReleaseId };
}

export async function auditStudioActivityDiscussion({ query, source, sessionId }) {
  const [summary] = await query(
    `SELECT id,knowledge_release_id,context_snapshot->'sourceContents'->'readings' AS readings,
            context_snapshot->'retrievalEvidence' AS retrievals,jsonb_array_length(evidence) AS citation_count
       FROM workbench.requirement_summaries WHERE session_id=$1 ORDER BY version DESC LIMIT 1`,
    [sessionId],
  );
  assert.ok(summary?.citation_count > 0);
  assert.ok(summary.retrievals.length > 0 && summary.retrievals.every(item =>
    item.mode === "hybrid" && item.routeScope === "production" && item.release.id === summary.knowledge_release_id,
  ));
  return {
    summaryId: summary.id,
    analyzedOriginalSha256: verifyOriginal(source, summary.readings),
    publishedKnowledgeId: summary.knowledge_release_id,
    publishedCitationCount: summary.citation_count,
  };
}

function verifyOriginal(source, readings) {
  const read = readings.find(item => item.sourceId === source.sourceId && item.originalBlobId === source.blobId);
  assert.ok(read && read.sha256 === source.sha256 && sha256(read.text) === source.sha256);
  return read.sha256;
}
