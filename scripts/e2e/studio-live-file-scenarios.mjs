import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const digest = (data) => createHash("sha256").update(data).digest("hex");

function wordFixture(marker) {
  const document =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const relationships =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="${document}"><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
      ),
    }),
  );
}

export async function runStudioLiveFileScenarios({
  page,
  browser,
  webOrigin,
  outDir,
  runId,
  dbUrl,
  sql,
  waitUntil,
  evidence,
  step,
  s3,
  bucket,
}) {
  assert.match(new URL(dbUrl).pathname, /_test_/);
  const connection = new URL(dbUrl);
  // Prisma sets this for normal writes. pg also needs it when the isolated
  // viewer fixture invokes the project membership constraint trigger.
  connection.searchParams.set("options", "-c search_path=workbench,public");
  const query = async (statement, params) =>
    (await sql(statement, params, connection.href)).rows;
  const fileReport = { deliveries: [], browserApiInterception: false };
  const checkpoint = () =>
    writeFile(
      path.join(outDir, "file-results.json"),
      JSON.stringify(fileReport, null, 2),
    );
  const api = (actor, method, url, body, headers) =>
    actor.evaluate(
      async ({ method, url, body, headers }) => {
        const response = await fetch("/api/v1" + url, {
          method,
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          body: await response.json().catch(() => null),
        };
      },
      { method, url, body, headers },
    );
  async function register(actor, role) {
    await actor.goto(webOrigin + "/register");
    await waitUntil(
      async () => (await actor.locator("#username").count()) === 1,
      "Registration form hydrated",
    );
    await actor.locator("#username").fill(role + "_" + runId);
    await actor.locator("#email").fill(role + "_" + runId + "@example.test");
    await actor
      .locator("#password")
      .fill(randomBytes(24).toString("base64url") + "!1aA");
    await actor
      .getByRole("button", { name: "创建工作台", exact: true })
      .click();
    await actor.waitForURL(webOrigin + "/");
  }
  step("Register the file owner and open the Studio project materials view");
  await register(page, "files");
  await page
    .getByRole("textbox", { name: "新项目名称" })
    .fill("文件验收 " + runId);
  await page.getByRole("button", { name: "创建项目 →", exact: true }).click();
  await page.waitForURL(/\/studio\//);
  const projectId = new URL(page.url()).pathname.split("/").at(-1);
  await page.goto(webOrigin + "/studio/" + projectId + "?view=resources");
  const picker = page.getByLabel("项目资料文件", { exact: true });
  async function upload(name, bytes, replace = false) {
    await picker.setInputFiles({
      name,
      mimeType: name.endsWith(".docx")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "text/markdown",
      buffer: bytes,
    });
    await page
      .getByRole("button", {
        name: replace ? "上传并替换" : "上传文件",
        exact: true,
      })
      .click();
  }
  const fixture = (suffix) => ({
    name: "studio-" + suffix + ".md",
    marker: "material-" + runId + "-" + suffix,
  });
  async function verifyFile(doc, replace = false) {
    const bytes = doc.name.endsWith(".docx")
      ? wordFixture(doc.marker)
      : Buffer.from("# Project file\n\n" + doc.marker + "\n");
    await upload(doc.name, bytes, replace);
    const row = await waitUntil(
      async () => {
        const [row] = await query(
          `SELECT s.id, s.revision, s.checksum, f.id AS file_id, bs.scanner, bs.scanner_version, bs.signature_version,
        bs.status AS scan, e.id AS extraction, e.external_task_id, e.status AS extraction_status, e.parser_version
        FROM workbench.import_sources s JOIN workbench.import_source_blobs m ON m.import_source_id=s.id
        JOIN workbench.file_assets f ON f.id=m.file_asset_id JOIN workbench.blob_scans bs ON bs.blob_id=f.blob_id
        JOIN workbench.file_extractions e ON e.id=f.current_extraction_id
        WHERE s.project_id=$1 AND s.label=$2 AND s.status='ready'`,
          [projectId, doc.name],
        );
        const alert = await page
          .getByRole("region", { name: "项目文件" })
          .getByRole("alert")
          .allTextContents();
        if (!row && alert.length)
          throw Object.assign(
            new Error("File processing: " + alert.join(" ")),
            { fatal: true },
          );
        return row;
      },
      "Verified upload " + doc.name,
      120000,
    );
    assert.equal(row.checksum, digest(bytes));
    assert.equal(row.scanner, "clamav");
    assert.equal(row.scan, "clean");
    assert.ok(row.signature_version && row.scanner_version);
    assert.equal(row.extraction_status, "ready");
    assert.ok(row.external_task_id);
    assert.match(row.parser_version, /docling-serve\/1\.26\.0/);
    const outputs = await query(
      `SELECT o.kind, b.storage_key, b.sha256 FROM workbench.file_extraction_outputs o
      JOIN workbench.blobs b ON b.id=o.blob_id WHERE o.extraction_id=$1 ORDER BY o.kind`,
      [row.extraction],
    );
    assert.deepEqual(
      outputs.map((o) => o.kind),
      ["docling_json", "markdown"],
    );
    for (const output of outputs) {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: output.storage_key }),
      );
      const data = await object.Body.transformToByteArray();
      assert.equal(digest(data), output.sha256);
      assert.ok(Buffer.from(data).toString("utf8").includes(doc.marker));
    }
    fileReport.deliveries.push({
      name: doc.name,
      ...row,
      outputs: outputs.map(({ kind, sha256 }) => ({ kind, sha256 })),
    });
    await checkpoint();
    await page.getByRole("heading", { name: doc.name, exact: true }).waitFor();
    return row;
  }
  const first = fixture("original"),
    next = { ...fixture("replacement"), name: "studio-replacement.docx" };
  step(
    "Upload and parse the original file, then select it for the current composer draft",
  );
  const original = await verifyFile(first);
  await page.getByRole("checkbox", { name: "本次引用 " + first.name }).check();
  await page
    .getByLabel("已引用资料")
    .getByText(first.name, { exact: false })
    .waitFor();
  await page.screenshot({
    path: path.join(outDir, "file-original-selected.png"),
  });

  step(
    "Use a read-only member to verify upload, replacement and removal authorization",
  );
  const viewerContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    await register(viewer, "fileviewer");
    const identity = await api(viewer, "GET", "/identity/me");
    assert.equal(identity.status, 200);
    await query(
      `INSERT INTO workbench.project_members(project_id,workspace_id,principal_id,role,updated_at)
      SELECT id,workspace_id,$2,'viewer',now() FROM workbench.projects WHERE id=$1`,
      [projectId, identity.body.id],
    );
    await viewer.goto(webOrigin + "/studio/" + projectId + "?view=resources");
    await viewer
      .getByRole("heading", { name: first.name, exact: true })
      .waitFor();
    assert.equal(
      await viewer.getByLabel("项目资料文件", { exact: true }).count(),
      0,
    );
    assert.equal(
      await viewer
        .getByRole("checkbox", { name: "本次引用 " + first.name })
        .isDisabled(),
      true,
    );
    const h = { "Idempotency-Key": randomUUID() };
    const requests = [
      [
        "POST",
        "/projects/" + projectId + "/file-upload-sessions",
        {
          fileName: "viewer.md",
          declaredMediaType: "text/markdown",
          byteSize: 20,
        },
        h,
      ],
      [
        "POST",
        "/projects/" + projectId + "/import-sources",
        {
          kind: "file",
          fileAssetId: original.file_id,
          replaces: { sourceId: original.id, revision: original.revision },
        },
        h,
      ],
      [
        "DELETE",
        "/import-sources/" + original.id,
        undefined,
        { "If-Match": '"' + original.revision + '"' },
      ],
    ];
    fileReport.viewerMembership =
      "registered test account granted viewer in the isolated database";
    fileReport.viewerWrites = [];
    for (const request of requests) {
      const result = await api(viewer, ...request);
      assert.ok(
        [403, 404].includes(result.status),
        "Viewer write should be denied (" + result.status + ")",
      );
      fileReport.viewerWrites.push(result.status);
    }
  } finally {
    await viewerContext.close();
  }
  step(
    "Recover from a real parser rejection and replace the original file atomically",
  );
  await page
    .getByRole("combobox", { name: "文件操作" })
    .selectOption(original.id);
  // An empty Markdown document is clean but contains no extractable content.
  await upload("empty-" + runId + ".md", Buffer.from("  \n   \n"), true);
  await page
    .getByRole("region", { name: "项目文件" })
    .getByRole("alert")
    .first()
    .waitFor({ timeout: 120000 });
  const failed = await query(
    `SELECT e.status,e.failure_code FROM workbench.file_assets f JOIN workbench.file_extractions e ON e.file_asset_id=f.id
    WHERE f.project_id=$1 AND f.original_name=$2`,
    [projectId, "empty-" + runId + ".md"],
  );
  assert.ok(["failed", "unsupported"].includes(failed[0]?.status));
  assert.equal(failed[0].failure_code, "EXTRACTION_EMPTY_CONTENT");
  await page
    .getByRole("alert")
    .filter({ hasText: "文档中没有可提取的文字" })
    .waitFor();
  assert.equal(
    (await api(page, "GET", "/import-sources/" + original.id)).status,
    200,
  );
  fileReport.parserFailure = failed[0];
  await page.screenshot({
    path: path.join(outDir, "file-parser-rejection.png"),
  });
  const replacement = await verifyFile(next, true);
  assert.notEqual(replacement.id, original.id);
  assert.equal(
    (await api(page, "GET", "/import-sources/" + original.id)).status,
    404,
  );
  const chips = page.getByLabel("已引用资料");
  await chips.getByText(/不可用/).waitFor();
  await chips.getByRole("button", { name: "移除引用 " + first.name }).click();
  await page.getByRole("checkbox", { name: "本次引用 " + next.name }).check();
  await chips.getByText(next.name, { exact: false }).waitFor();
  const article = page
    .locator("article")
    .filter({
      has: page.getByRole("heading", { name: next.name, exact: true }),
    });
  await article.getByRole("button", { name: "移除", exact: true }).click();
  await article.waitFor({ state: "detached" });
  assert.equal(
    (await api(page, "GET", "/import-sources/" + replacement.id)).status,
    404,
  );
  const rows = await query(
    `SELECT s.id,s.status,m.sha256 FROM workbench.import_sources s JOIN workbench.import_source_blobs m ON m.import_source_id=s.id
    WHERE s.project_id=$1 ORDER BY s.created_at`,
    [projectId],
  );
  assert.deepEqual(
    rows,
    [original, replacement].map((r) => ({
      id: r.id,
      status: "deleted",
      sha256: r.checksum,
    })),
  );
  const runs = await query(
    "SELECT count(*)::int AS n FROM workbench.runs WHERE project_id=$1",
    [projectId],
  );
  assert.equal(runs[0].n, 0);
  fileReport.retiredManifests = rows;
  fileReport.generatedRuns = runs[0].n;
  evidence.checks.fileDelivery = fileReport;
  await checkpoint();
}
