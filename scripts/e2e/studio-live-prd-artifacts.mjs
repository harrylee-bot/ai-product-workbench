import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { prdDocumentSchema } from "@workbench/workbench-contracts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const fatal = (message) => Object.assign(new Error(message), { fatal: true });
const run = (binary, args) =>
  execFileSync(binary, args, {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });

export async function publishPrd({
  page,
  webOrigin,
  outDir,
  project,
  artifact,
  post,
  query,
  waitUntil,
  prd,
  step,
  checkpoint,
}) {
  step(
    "Publish the generated PRD in Studio, download its DOCX and PDF, and render every page",
  );
  await page.goto(webOrigin + "/studio/" + project + "?view=publishing");
  const created = post(/\/releases$/);
  await page.getByRole("button", { name: "创建项目发布", exact: true }).click();
  const response = await created;
  assert.ok(response.ok(), "Publish HTTP " + response.status());
  const release = await response.json();
  assert.ok(
    release.artifactPins.some(
      (pin) =>
        pin.artifactVersionId === artifact.id &&
        pin.checksum === artifact.checksum,
    ),
  );
  prd.releaseId = release.id;
  prd.downloads = {};
  const render = path.join(outDir, "render");
  await mkdir(render, { recursive: true });
  for (const format of ["docx", "pdf"]) {
    const queued = post(/\/exports$/);
    await page
      .getByRole("article", { name: "发布 " + release.version, exact: true })
      .getByRole("button", {
        name: "导出 " + format.toUpperCase(),
        exact: true,
      })
      .click();
    const queuedResponse = await queued;
    assert.ok(queuedResponse.ok(), "Export HTTP " + queuedResponse.status());
    const job = await queuedResponse.json();
    assert.equal(
      queuedResponse.request().postDataJSON().selection.artifactVersionId,
      artifact.id,
    );
    const row = await waitUntil(
      async () => {
        const [r] = await query(
          "SELECT e.status,e.failure_code,b.sha256,b.byte_size FROM workbench.export_jobs e LEFT JOIN workbench.blobs b ON b.id=e.output_blob_id WHERE e.id=$1",
          [job.id],
        );
        if (r?.status === "failed")
          throw fatal("Export " + format + " failed: " + r.failure_code);
        return r?.status === "succeeded" && r;
      },
      "Official " + format + " export",
      180000,
    );
    const event = page.waitForEvent("download");
    await page
      .getByRole("article", { name: "导出 " + job.id, exact: true })
      .getByRole("button", { name: "下载并校验", exact: true })
      .click();
    const file = path.join(outDir, "prd." + format);
    await (await event).saveAs(file);
    const bytes = await readFile(file);
    assert.equal(sha(bytes), row.sha256);
    assert.equal(bytes.length, Number(row.byte_size));
    const entry = (prd.downloads[format] = {
      sha256: row.sha256,
      byteSize: bytes.length,
      jobId: job.id,
    });
    if (format === "docx") {
      assert.match(
        Buffer.from(unzipSync(bytes)["word/document.xml"]).toString("utf8"),
        /渠道/,
      );
      run(process.env.WORKBENCH_STUDIO_LIVE_OFFICE_BIN || "soffice", [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        render,
        file,
      ]);
    }
    const pdf = format === "docx" ? path.join(render, "prd.pdf") : file;
    const info = run(
      process.env.WORKBENCH_STUDIO_LIVE_PDFINFO_BIN || "pdfinfo",
      [pdf],
    );
    entry.pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    assert.ok(entry.pages > 0);
    run(process.env.WORKBENCH_STUDIO_LIVE_PDFTOPPM_BIN || "pdftoppm", [
      "-r",
      "72",
      "-png",
      pdf,
      path.join(render, format),
    ]);
    const text = run(
      process.env.WORKBENCH_STUDIO_LIVE_PDFTOTEXT_BIN || "pdftotext",
      ["-layout", pdf, "-"],
    );
    await writeFile(path.join(render, format + ".txt"), text);
    entry.textSha256 = sha(text);
    entry.pageHashes = [];
    for (const f of (await readdir(render))
      .filter((f) => f.startsWith(format + "-") && f.endsWith(".png"))
      .sort())
      entry.pageHashes.push(sha(await readFile(path.join(render, f))));
    assert.equal(entry.pageHashes.length, entry.pages);
    await checkpoint();
  }
  assert.deepEqual(
    prd.downloads.docx.pageHashes,
    prd.downloads.pdf.pageHashes,
    "The independently opened DOCX and delivered PDF must show identical page content",
  );
}

export async function auditPrd({ query, artifact, frozen }) {
  const doc = prdDocumentSchema.parse(artifact.content);
  const releaseId = frozen.input_snapshot.knowledgeReleaseId;
  assert.equal(artifact.knowledge_release_id, releaseId);
  const invocations = await query(
    "SELECT i.id,i.status,i.response FROM workbench.knowledge_retrieval_invocations i JOIN workbench.runtime_attempts a ON a.id=i.runtime_attempt_id WHERE a.run_id=$1",
    [frozen.run_id],
  );
  const retrieved = new Map(
    invocations
      .filter((i) => i.status === "succeeded")
      .flatMap((i) =>
        (i.response.items || []).map((item) => [
          item.citation.id,
          item.citation,
        ]),
      ),
  );
  assert.ok(
    retrieved.size,
    "The generating Run must actually retrieve knowledge",
  );
  assert.ok(
    artifact.citations.length && doc.citations.length,
    "The generated document must retain verified citations",
  );
  const traces = [];
  for (const citation of [...frozen.baseline.evidence, ...artifact.citations]) {
    const [chunk] = await query(
      "SELECT c.content,d.source_path,d.metadata FROM workbench.knowledge_chunks c JOIN workbench.knowledge_documents d ON d.id=c.document_id AND d.release_id=c.release_id WHERE c.id=$1 AND c.release_id=$2 AND c.document_id=$3",
      [citation.chunkId, releaseId, citation.documentId],
    );
    assert.ok(chunk && chunk.source_path === citation.sourcePath);
    assert.ok(
      citation.quote && chunk.content.includes(citation.quote),
      "Citation must match published chunk text",
    );
    assert.ok(
      chunk.metadata.copiedFromPublishedRelease?.id &&
        chunk.metadata.originalDocumentId,
    );
    if (citation.releaseId) {
      assert.equal(citation.releaseId, releaseId);
      assert.equal(citation.checksum, sha(citation.quote));
    } else {
      const source = retrieved.get(citation.id);
      assert.equal(source?.chunkId, citation.chunkId);
    }
    traces.push({
      id: citation.id,
      chunkId: citation.chunkId,
      sourcePath: citation.sourcePath,
      quoteSha256: sha(citation.quote),
      originalReleaseId: chunk.metadata.copiedFromPublishedRelease.id,
    });
  }
  assert.deepEqual(
    new Set(doc.citations.map((c) => c.id)),
    new Set(artifact.citations.map((c) => c.id)),
  );
  const card = frozen.baseline.card;
  assert.ok(
    card.reuse.length &&
      card.changes.length &&
      card.preserved.length &&
      !card.platformChanges.length,
  );
  const strings = [];
  function collect(node) {
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (typeof node === "object" && node !== null) {
      Object.values(node).forEach(collect);
      return;
    }
    if (typeof node === "string") strings.push(node);
  }
  collect(doc.sections);
  const requirements = {
    platform: /云溪|极速发布/,
    currentList: /活动管理|活动列表/,
    roles: /策划/,
    attribution: /区域/,
    channels: /企微|企业微信/,
    sms: /短信/,
    all: /全部/,
    pagination: /第一页|第\s*1\s*页|首页|首[页版]|页码.{0,12}1/,
    empty: /无匹配|空状态|无结果|暂无|为空|空列表/,
    retry: /重试|重新加载|再试/,
    retain: /保留|保持/,
  };
  const mapped = {};
  for (const [key, required] of Object.entries(requirements)) {
    mapped[key] = strings.find((t) => required.test(t));
    assert.ok(
      mapped[key],
      "Missing confirmed business requirement in PRD body: " + key,
    );
  }
  return {
    requirements: mapped,
    traces,
    retrievalInvocations: invocations.map((i) => ({
      id: i.id,
      status: i.status,
    })),
    confirmed: {
      reuse: card.reuse,
      changes: card.changes,
      preserved: card.preserved,
    },
  };
}
