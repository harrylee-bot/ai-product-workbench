// Real multipart uploader, image decoder/cropper and Studio; controlled server/storage responses.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  artifactSchema,
  artifactVersionDetailSchema,
  artifactCreationSchema,
  createFileUploadResponseSchema,
  signUploadPartResponseSchema,
  completeFileUploadResponseSchema,
} from "@workbench/workbench-contracts";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930",
  output = new URL("../../output/audit/1.0.0/studio-media/", import.meta.url);
await mkdir(output, { recursive: true });
const now = "2026-11-16T00:00:00Z",
  projectId = "media-project",
  digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = await sharp({
  create: {
    width: 128,
    height: 80,
    channels: 4,
    background: { r: 32, g: 110, b: 230, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const project = {
  id: projectId,
  workspaceId: "workspace-1",
  title: "图片编辑验证",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: "thread-1",
  projectId,
  title: "需求",
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const artifacts = [],
  versions = new Map(),
  files = new Map(),
  receipts = new Map(),
  writeKeys = [];
let uploadCount = 0,
  artifactWrites = 0,
  versionWrites = 0,
  loseCreation = true,
  loseVersion = true,
  slowPart = false,
  role = "owner";
const results = {
  evidence:
    "Real new Studio, Uppy multipart upload and actual decoded/cropped PNG bytes, controlled API/storage responses; not production acceptance",
  checks: [],
  errors: [],
  unknown: [],
  requests: [],
};
const bootstrap = () => ({
  project,
  access: { role },
  threads: [thread],
  selectedThreadId: thread.id,
  entries: [],
  board: {
    id: "board-1",
    projectId,
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  },
  artifacts,
  latestRun: null,
});
const json = (route, value, status = 200, etag = '"1"') =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { etag },
    body: JSON.stringify(value),
  });
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  }),
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
await context.addCookies([
  { name: "workbench.session_token", value: "media-fixture", url: origin },
]);
const createVersion = (a, file, version) => {
  const id = `${a.id}-v${version}`,
    checksum = digest(file.bytes);
  const summary = {
    artifactId: a.id,
    artifactVersionId: id,
    version,
    kind: "image",
    schemaVersion: 1,
    status: "ready",
    checksum,
    createdByRunId: null,
    createdAt: now,
  };
  const detail = artifactVersionDetailSchema.parse({
    ...summary,
    contentMode: "blob",
    citations: [],
    knowledgeReleaseId: null,
    sourcePrdVersionId: null,
    blob: {
      blobId: file.file.blobId,
      mediaType: file.file.detectedMediaType,
      byteSize: file.bytes.length,
      sha256: checksum,
      fileName: file.file.originalName,
    },
  });
  versions.set(id, { summary, detail, bytes: file.bytes });
  a.currentVersion = summary;
  return detail;
};
await context.route("**/api/**", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname,
    method = request.method();
  results.requests.push(`${method} ${path}`);
  if (path === "/api/auth/get-session")
    return json(route, {
      session: {
        id: "session",
        token: "media-fixture",
        userId: "owner-1",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: now,
        updatedAt: now,
      },
      user: {
        id: "owner-1",
        name: "图片验收",
        email: "owner@example.test",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  if (path.endsWith("/identity/me"))
    return json(route, {
      id: "owner-1",
      issuer: "https://identity.example.test",
      subject: "owner",
      email: "owner@example.test",
      displayName: "图片验收",
      defaultWorkspaceId: "workspace-1",
    });
  if (path.endsWith("/identity/preferences"))
    return json(route, {
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
  if (path.endsWith("/bootstrap")) return json(route, bootstrap());
  if (path.endsWith("/runtime/models") || path.endsWith("/design-presets"))
    return json(route, { items: [] });
  if (path.endsWith("/submission-intents/current"))
    return json(route, { item: null });
  if (
    [
      "/prototype-v2/plans",
      "/prototype-v2/shares",
      "/prototype-v2/exports",
    ].some((s) => path.endsWith(s))
  )
    return json(route, []);
  if (path === `/api/v1/projects/${projectId}/file-upload-sessions`) {
    const body = request.postDataJSON(),
      id = `file-${++uploadCount}`,
      uploadId = `upload-${uploadCount}`;
    const file = {
      id,
      projectId,
      blobId: null,
      originalName: body.fileName,
      declaredMediaType: body.declaredMediaType,
      detectedMediaType: null,
      byteSize: body.byteSize,
      status: "uploading",
      revision: 1,
      sha256: null,
      failure: null,
      currentExtraction: null,
      latestExtraction: null,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const upload = {
      id: uploadId,
      fileAssetId: id,
      status: "initiated",
      partSize: 5 * 1024 ** 2,
      revision: 1,
      expiresAt: "2099-01-01T00:00:00Z",
    };
    files.set(id, { file, upload, bytes: null, shaHint: body.sha256 });
    return json(
      route,
      createFileUploadResponseSchema.parse({ file, upload }),
      201,
    );
  }
  const f = [...files.values()].find(
    (f) =>
      path.includes(`/file-upload-sessions/${f.upload.id}`) ||
      path === `/api/v1/files/${f.file.id}` ||
      path === `/api/fixture-storage/${f.upload.id}`,
  );
  if (f) {
    if (path.startsWith("/api/fixture-storage/")) {
      f.bytes = request.postDataBuffer();
      assert.equal(f.bytes.length, f.file.byteSize);
      if (slowPart) await new Promise((resolve) => setTimeout(resolve, 5000));
      return route
        .fulfill({ status: 200, headers: { etag: '"fixture-part"' }, body: "" })
        .catch(() => {});
    }
    if (method === "DELETE") {
      f.upload.status = "aborted";
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/parts/1")) {
      const body = request.postDataJSON();
      assert.equal(body.contentLength, f.file.byteSize);
      return json(
        route,
        signUploadPartResponseSchema.parse({
          uploadSessionId: f.upload.id,
          partNumber: 1,
          method: "PUT",
          url: `${origin}/api/fixture-storage/${f.upload.id}`,
          headers: {},
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      );
    }
    if (path.endsWith("/parts"))
      return json(route, {
        parts: f.bytes
          ? [
              {
                partNumber: 1,
                etag: '"fixture-part"',
                byteSize: f.bytes.length,
              },
            ]
          : [],
      });
    if (path.endsWith("/complete")) {
      assert(f.bytes);
      if (f.shaHint) assert.equal(f.shaHint, digest(f.bytes));
      assert.equal(request.postDataJSON().parts[0].etag, '"fixture-part"');
      f.file = {
        ...f.file,
        blobId: `blob-${f.file.id}`,
        detectedMediaType: f.file.declaredMediaType,
        status: "ready",
        revision: 2,
        sha256: digest(f.bytes),
        verifiedAt: now,
      };
      f.upload = { ...f.upload, status: "completed", revision: 2 };
      return json(
        route,
        completeFileUploadResponseSchema.parse({
          file: f.file,
          upload: f.upload,
        }),
        200,
        '"2"',
      );
    }
    if (path.startsWith("/api/v1/files/"))
      return json(route, f.file, 200, `"${f.file.revision}"`);
    return json(route, f.upload, 200, `"${f.upload.revision}"`);
  }
  if (path === `/api/v1/projects/${projectId}/artifacts`) {
    if (method === "GET")
      return json(route, { items: artifacts, nextCursor: null });
    const body = request.postDataJSON(),
      key = request.headers()["idempotency-key"];
    writeKeys.push({ kind: "create", key, body });
    if (receipts.has(key)) return json(route, receipts.get(key), 201);
    const f = files.get(body.source.fileAssetId);
    assert.equal(f.file.status, "ready");
    artifactWrites++;
    const a = {
      id: `image-${artifactWrites}`,
      projectId,
      kind: "image",
      title: body.title,
      revision: 1,
      currentVersion: null,
      createdAt: now,
      updatedAt: now,
    };
    const detail = createVersion(a, f, 1);
    artifactSchema.parse(a);
    artifacts.push(a);
    const response = artifactCreationSchema.parse({
      artifact: a,
      artifactVersion: detail,
    });
    receipts.set(key, response);
    if (loseCreation) {
      loseCreation = false;
      return json(
        route,
        {
          status: 503,
          title: "Response lost",
          type: "about:blank",
          code: "SERVICE_UNAVAILABLE",
        },
        503,
      );
    }
    return json(route, response, 201);
  }
  const a = artifacts.find(
    (a) =>
      path === `/api/v1/artifacts/${a.id}` ||
      path.startsWith(`/api/v1/artifacts/${a.id}/`),
  );
  if (a) {
    if (path.endsWith("/versions")) {
      if (method === "GET")
        return json(route, {
          items: [...versions.values()]
            .filter((v) => v.summary.artifactId === a.id)
            .map((v) => ({ ...v.summary, contentMode: "blob" })),
          nextCursor: null,
        });
      const body = request.postDataJSON(),
        key = request.headers()["idempotency-key"];
      writeKeys.push({ kind: "version", key, body });
      if (receipts.has(key))
        return json(route, receipts.get(key), 201, `"${a.revision}"`);
      assert.equal(request.headers()["if-match"], `"${a.revision}"`);
      assert.equal(
        body.baseArtifactVersionId,
        a.currentVersion.artifactVersionId,
      );
      const f = files.get(body.source.fileAssetId);
      assert.equal(f.file.status, "ready");
      versionWrites++;
      const detail = createVersion(a, f, a.currentVersion.version + 1);
      a.revision++;
      receipts.set(key, detail);
      if (loseVersion) {
        loseVersion = false;
        return json(
          route,
          {
            status: 503,
            title: "Response lost",
            type: "about:blank",
            code: "SERVICE_UNAVAILABLE",
          },
          503,
        );
      }
      return json(route, detail, 201, `"${a.revision}"`);
    }
    const v = [...versions.values()].find((v) =>
      path.includes(`/versions/${v.summary.artifactVersionId}`),
    );
    if (v) {
      if (path.endsWith("/content"))
        return route.fulfill({ contentType: "image/png", body: v.bytes });
      return json(route, v.detail, 200, `"${v.summary.checksum}"`);
    }
    return json(route, a, 200, `"${a.revision}"`);
  }
  if (
    ["/import-sources", "/design-systems", "/releases"].some((s) =>
      path.endsWith(s),
    )
  )
    return json(route, { items: [], nextCursor: null });
  results.unknown.push(`${method} ${path}`);
  return json(route, { status: 404, title: "Fixture route missing" }, 404);
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("pageerror", (error) => results.errors.push(error.message));
const selectFile = async (name = "source.png") =>
  page
    .getByLabel("选择图片文件")
    .setInputFiles({ name, mimeType: "image/png", buffer: bytes });
const wait = async (fn, message) => {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await page.waitForTimeout(100);
  }
  throw Error(message);
};
try {
  await page.goto(`${origin}/studio/${projectId}?view=documents`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await selectFile();
  await page.getByRole("checkbox", { name: "裁剪图片", exact: true }).check();
  await page.getByText("保存尺寸：80 × 80 像素", { exact: true }).waitFor();
  await page.screenshot({ path: new URL("crop-upload.png", output).pathname });
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [768, 1024],
    [390, 844],
    [360, 800],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(120);
    const metrics = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      editor: document
        .querySelector(".studio-image-editor")
        .getBoundingClientRect().width,
    }));
    assert(
      metrics.scroll <= width + 1,
      `media overflow ${width}: ${JSON.stringify(metrics)}`,
    );
    assert(metrics.editor < width);
    if (width === 390)
      await page.screenshot({
        path: new URL("crop-mobile.png", output).pathname,
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  results.checks.push(
    "crop editor fits five required desktop/tablet/phone viewports without outer horizontal overflow",
  );
  await page.getByRole("button", { name: "保存图片", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Response lost" }).waitFor();
  await page.getByRole("button", { name: "保存图片", exact: true }).click();
  await page
    .getByRole("link", { name: "查看已保存图片", exact: true })
    .waitFor();
  assert.equal(uploadCount, 1);
  assert.equal(artifactWrites, 1);
  assert.equal(writeKeys[0].key, writeKeys[1].key);
  const first = versions.get("image-1-v1"),
    meta = await sharp(first.bytes).metadata();
  assert.equal(meta.width, 80);
  assert.equal(meta.height, 80);
  const originalHash = digest(first.bytes);
  results.checks.push(
    "real selected PNG decodes and crops to 80×80, uploads actual multipart bytes and creates one image despite lost response; retry reuses uploaded File and idempotency key",
  );
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole("link", { name: "查看已保存图片", exact: true }).click();
  await page.getByRole("button", { name: "编辑图片", exact: true }).click();
  await page.getByRole("checkbox", { name: "裁剪图片", exact: true }).check();
  await page.getByLabel("裁剪比例").selectOption(String(16 / 9));
  await page.getByText("保存尺寸：80 × 45 像素", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Response lost" }).waitFor();
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await page
    .getByRole("link", { name: "查看已保存图片", exact: true })
    .waitFor();
  assert.equal(versionWrites, 1);
  assert.equal(uploadCount, 2);
  assert.equal(writeKeys[2].key, writeKeys[3].key);
  assert.equal(digest(versions.get("image-1-v1").bytes), originalHash);
  const second = await sharp(versions.get("image-1-v2").bytes).metadata();
  assert.equal(second.width, 80);
  assert.equal(second.height, 45);
  results.checks.push(
    "editing fixed image publishes a real 80×45 PNG as version 2, retries the accepted write once, and leaves source version bytes unchanged",
  );
  await page.getByRole("link", { name: "查看已保存图片", exact: true }).click();
  await page.getByRole("img", { name: "source", exact: true }).waitFor();
  await page.goto(
    `${origin}/studio/${projectId}?view=documents&artifact=image-1&artifactVersion=image-1-v1`,
    { waitUntil: "networkidle" },
  );
  await page.getByRole("button", { name: "编辑图片", exact: true }).click();
  assert(
    await page
      .getByRole("button", { name: "保存为新版本", exact: true })
      .isDisabled(),
  );
  assert(
    await page
      .getByRole("button", { name: "另存为新图片", exact: true })
      .isEnabled(),
  );
  results.checks.push(
    "historical version remains previewable; overwriting the current lineage from an old base is disabled and explicit save-as remains available",
  );
  await page.getByRole("button", { name: "关闭图片编辑", exact: true }).click();
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await selectFile("cancel.png");
  slowPart = true;
  await page.getByRole("button", { name: "保存图片", exact: true }).click();
  await wait(
    () => uploadCount === 3 && files.get("file-3").bytes,
    "upload starts",
  );
  await page.getByRole("button", { name: "取消图片上传", exact: true }).click();
  await page.getByText("上传已取消", { exact: true }).waitFor();
  assert.equal(files.get("file-3").upload.status, "aborted");
  assert.equal(artifactWrites, 1);
  results.checks.push(
    "cancellation aborts the active multipart session and creates no artifact",
  );
  await page.getByRole("button", { name: "关闭图片编辑", exact: true }).click();
  await page.getByRole("button", { name: "添加图片", exact: true }).click();
  await selectFile("late.png");
  await page.getByRole("button", { name: "保存图片", exact: true }).click();
  await wait(
    () => uploadCount === 4 && files.get("file-4").bytes,
    "late upload starts",
  );
  await page
    .locator(".studio-rail")
    .getByRole("button", { name: "资料", exact: true })
    .click();
  await page.waitForTimeout(5500);
  assert.equal(artifactWrites, 1);
  assert.equal(versionWrites, 1);
  results.checks.push(
    "leaving the media view destroys the upload controller; late part completion cannot create or navigate to an artifact",
  );
  role = "viewer";
  await page.goto(
    `${origin}/studio/${projectId}?view=documents&artifact=image-1&artifactVersion=image-1-v2`,
    { waitUntil: "networkidle" },
  );
  assert.equal(
    await page.getByRole("button", { name: "添加图片", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "编辑图片", exact: true }).count(),
    0,
  );
  assert.deepEqual(results.unknown, []);
  assert.deepEqual(results.errors, []);
  results.checks.push(
    "viewer sees verified media but has no upload or edit actions",
  );
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.error = String(error.stack ?? error);
  await page
    .screenshot({ path: new URL("failure.png", output).pathname })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(
      { ...results, uploadCount, artifactWrites, versionWrites, writeKeys },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(JSON.stringify({ status: results.status, checks: results.checks }));
