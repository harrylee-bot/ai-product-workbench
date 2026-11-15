// Real isolated PreviewService and export runtime; controlled authorization/database and HTTP fixtures.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  canonicalJson,
  prototypeDocumentSchema,
  publicShareSchema,
  publicArtifactVersionDetailSchema,
  artifactVersionDetailSchema,
  artifactSchema,
  projectBootstrapSchema,
} from "@workbench/workbench-contracts";
import { createSourcePrototypePreviewToken } from "@workbench/workbench-preview-token";
import { prototypeDocumentFixture } from "../../packages/workbench-contracts/test/prototype-fixture.js";
import { PreviewService } from "../../apps/workbench-preview/src/preview.service.js";
import { preparePreviewResponse } from "../../apps/workbench-preview/src/preview-request.js";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  "../../output/audit/1.0.0/studio-artifact-preview/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-16T00:00:00Z",
  projectId = "artifact-project",
  artifactId = "artifact-one",
  versionId = "version-one",
  shareToken = `wbs_${"d".repeat(43)}`;
const secret = Buffer.alloc(32, 16),
  digest = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const content = prototypeDocumentFixture();
content.title = "固定发布的订阅原型";
const { text, maxLines, kind, ...base } = content.nodes[1] as any;
content.nodes[0].layout.width = { kind: "literal", value: 390 };
content.nodes[0].layout.height = { kind: "literal", value: 600 };
content.nodes[2].layout.width = { kind: "literal", value: 390 };
content.nodes[2].layout.height = { kind: "literal", value: 600 };
content.screens[1].viewport = { width: 390, height: 844 };
content.nodes[1] = {
  ...base,
  kind: "button",
  label: "进入完成页",
  childIds: [],
  buttonType: "button",
  disabled: false,
  actionIds: ["action-next"],
  layout: {
    ...base.layout,
    y: { kind: "literal", value: 140 },
    width: { kind: "literal", value: 240 },
  },
};
(content.nodes[3] as any).text = "固定版本 1：订阅完成";
content.nodes[3].layout.width = { kind: "literal", value: 380 };
for (const [id, inputType, label, y] of [
  ["input-email", "email", "联系邮箱", 20],
  ["input-check", "checkbox", "接收通知", 80],
] as const) {
  content.nodes.push({
    ...base,
    id,
    kind: "input",
    inputType,
    fieldName: id,
    label,
    placeholder: "",
    optionValue: null,
    bindingIds: [`binding-${id}`],
    options: [],
    required: false,
    disabled: false,
    actionIds: [],
    layout: {
      ...base.layout,
      y: { kind: "literal", value: y },
      width: { kind: "literal", value: 280 },
    },
  });
  (content.nodes[0] as any).childIds.push(id);
  content.variables.push({
    path: `form.${inputType}`,
    initialValue: inputType === "checkbox" ? false : "",
  });
  content.bindings.push({
    id: `binding-${id}`,
    nodeId: id,
    property: "value",
    source: { kind: "variable", path: `form.${inputType}` },
  });
}
content.actions = [
  {
    id: "action-next",
    nodeId: "node-a",
    event: "click",
    kind: "navigate",
    targetScreenId: "screen-b",
  },
];
prototypeDocumentSchema.parse(content);
const checksum = digest(canonicalJson(content));
const publicDetail = publicArtifactVersionDetailSchema.parse({
  artifactId,
  artifactVersionId: versionId,
  version: 1,
  kind: "prototype",
  schemaVersion: 1,
  status: "ready",
  checksum,
  citations: [],
  createdAt: now,
  contentMode: "inline",
  content,
});
const privateDetail = artifactVersionDetailSchema.parse({
  ...publicDetail,
  createdByRunId: null,
  sourcePrdVersionId: null,
  knowledgeReleaseId: null,
});
const versionSummary = {
  artifactId,
  artifactVersionId: versionId,
  version: 1,
  kind: "prototype",
  schemaVersion: 1,
  status: "ready",
  checksum,
  createdByRunId: null,
  createdAt: now,
};
const artifact = artifactSchema.parse({
  id: artifactId,
  projectId,
  kind: "prototype",
  title: content.title,
  revision: 2,
  currentVersion: {
    ...versionSummary,
    artifactVersionId: "version-current",
    version: 2,
  },
  createdAt: now,
  updatedAt: now,
});
const project = {
  id: projectId,
  workspaceId: "workspace-one",
  title: "产物预览验收",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const board = {
  id: "board-one",
  projectId,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
};
const thread = {
  id: "thread-one",
  projectId,
  title: "需求",
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const imageSummary = {
  artifactId: "image-one",
  artifactVersionId: "image-v1",
  version: 1,
  kind: "image",
  schemaVersion: 1,
  status: "ready",
  checksum: digest(imageBytes),
  createdByRunId: null,
  createdAt: now,
};
const imageArtifact = artifactSchema.parse({
  id: "image-one",
  projectId,
  kind: "image",
  title: "项目图片",
  revision: 1,
  currentVersion: imageSummary,
  createdAt: now,
  updatedAt: now,
});
const imageDetail = artifactVersionDetailSchema.parse({
  ...imageSummary,
  citations: [],
  knowledgeReleaseId: null,
  contentMode: "blob",
  blob: {
    blobId: "image-blob",
    mediaType: "image/png",
    byteSize: imageBytes.length,
    sha256: digest(imageBytes),
    fileName: "reference.png",
  },
});
let corruptImage = true;
const bootstrap = projectBootstrapSchema.parse({
  project,
  access: { role: "viewer" },
  threads: [thread],
  selectedThreadId: thread.id,
  entries: [],
  board,
  artifacts: [artifact, imageArtifact],
  latestRun: null,
});
const pin = {
  position: 0,
  artifactId,
  artifactVersionId: versionId,
  title: content.title,
  kind: "prototype",
  version: 1,
  schemaVersion: 1,
  checksum,
};
const share = publicShareSchema.parse({
  shareId: "share-one",
  scope: "view",
  expiresAt: null,
  release: {
    id: "release-one",
    projectId,
    version: 1,
    status: "ready",
    boardId: board.id,
    boardRevision: 1,
    boardSnapshot: board,
    boardChecksum: "a".repeat(64),
    artifactPins: [pin],
    manifest: {
      protocol: "workbench.project-release.v1",
      projectId,
      releaseVersion: 1,
      board: { id: board.id, revision: 1, checksum: "a".repeat(64) },
      artifacts: [pin],
    },
    manifestSha256: "b".repeat(64),
    failure: null,
    createdAt: now,
    finishedAt: now,
    updatedAt: now,
  },
});
let state = "active",
  authenticated = false;
const requests: string[] = [],
  unknown: string[] = [],
  errors: string[] = [],
  previewRequests: string[] = [],
  checks: string[] = [];
const db = {
  artifactVersion: {
    findFirst: async (query: any) =>
      query.where.id === versionId &&
      query.where.artifactId === artifactId &&
      query.where.checksum === checksum
        ? { projectId, schemaVersion: 1, content, checksum, assets: [] }
        : null,
  },
  projectMember: {
    findFirst: async () => (authenticated ? { projectId } : null),
  },
  shareGrant: {
    findFirst: async (query: any) =>
      state === "active" &&
      query.where.revision === 1 &&
      query.where.artifactVersionId === versionId
        ? { id: "share-one" }
        : null,
  },
};
const service = new PreviewService(db as never, {} as never, {
  tokenSecret: secret,
  tokenMaximumTtlSeconds: 3600,
  maximumHtmlBytes: 2 * 1024 * 1024,
  webOrigin: origin,
});
const capability = (privateView: boolean) => {
  const expiresAt = new Date(Date.now() + 60_000);
  const token = createSourcePrototypePreviewToken(
    {
      artifactId,
      artifactVersionId: versionId,
      checksum,
      expiresAt,
      ...(privateView
        ? { principalId: "viewer-one" }
        : { shareId: "share-one", shareRevision: 1 }),
    },
    secret,
  );
  return {
    url: `http://localhost:4300/preview/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const json = (route: any, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      etag: route.request().url().includes("/public/")
        ? `"${checksum}"`
        : '"1"',
    },
    body: JSON.stringify(value),
  });
await context.route("http://localhost:4300/preview/**", async (route) => {
  assert.equal(route.request().headers().cookie, undefined);
  assert.equal(route.request().headers().authorization, undefined);
  try {
    const token = new URL(route.request().url()).pathname.slice(
      "/preview/".length,
    );
    const result = await preparePreviewResponse(service, {
      token,
      method: "GET",
    });
    assert(result.status === 200 && !result.head);
    const rendered = result.preview;
    const chunks = [];
    for await (const part of rendered.body) chunks.push(Buffer.from(part));
    await rendered.dispose();
    previewRequests.push("verified rendered artifact");
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": rendered.contentSecurityPolicy,
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
      body: Buffer.concat(chunks),
    });
  } catch {
    return route.fulfill({ status: 404, body: "Preview unavailable" });
  }
});
await context.route("**/api/**", (route) => {
  const url = new URL(route.request().url()),
    path = url.pathname;
  requests.push(path);
  if (path === "/api/auth/get-session")
    return json(
      route,
      authenticated
        ? {
            session: {
              id: "session",
              token: "fixture-session",
              userId: "viewer-one",
              expiresAt: "2099-01-01T00:00:00Z",
              createdAt: now,
              updatedAt: now,
              ipAddress: null,
              userAgent: "fixture",
            },
            user: {
              id: "viewer-one",
              name: "预览验收",
              email: "viewer@example.test",
              emailVerified: true,
              image: null,
              createdAt: now,
              updatedAt: now,
            },
          }
        : null,
    );
  if (path.startsWith("/api/v1/public/shares/")) {
    if (state !== "active")
      return json(
        route,
        {
          status: 404,
          type: "about:blank",
          title: "Unavailable",
          code: state === "revoked" ? "SHARE_REVOKED" : "SHARE_EXPIRED",
        },
        404,
      );
    if (path.endsWith("/preview-token")) return json(route, capability(false));
    if (path.endsWith(`/versions/${versionId}`))
      return json(route, publicDetail);
    if (path === `/api/v1/public/shares/${shareToken}`)
      return json(route, share);
  }
  if (authenticated) {
    if (path.endsWith("/identity/me"))
      return json(route, {
        id: "viewer-one",
        issuer: "https://identity.example.test",
        subject: "viewer",
        email: "viewer@example.test",
        displayName: "预览验收",
        defaultWorkspaceId: "workspace-one",
      });
    if (path.endsWith("/identity/preferences"))
      return json(route, {
        productUpdatesEmail: false,
        researchInvitations: false,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      });
    if (path.endsWith("/bootstrap")) return json(route, bootstrap);
    if (path.endsWith("/exports/capabilities"))
      return json(route, {
        formats: Object.fromEntries(
          ["html", "react", "figma", "mcp", "docx", "pdf"].map((key) => [
            key,
            { available: true, reasonCode: null },
          ]),
        ),
        packaging: {
          single_file: { available: true, reasonCode: null },
          zip: { available: true, reasonCode: null },
        },
      });
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
    if (path === "/api/v1/artifacts/image-one/versions")
      return json(route, {
        items: [{ ...imageSummary, contentMode: "blob" }],
        nextCursor: null,
      });
    if (path === "/api/v1/artifacts/image-one/versions/image-v1")
      return json(route, imageDetail);
    if (path === "/api/v1/artifacts/image-one/versions/image-v1/content")
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: corruptImage ? Buffer.alloc(imageBytes.length) : imageBytes,
      });
    if (path === `/api/v1/projects/${projectId}/artifacts`)
      return json(route, {
        items: [artifact, imageArtifact].filter(
          (item) =>
            !url.searchParams.has("kind") ||
            item.kind === url.searchParams.get("kind"),
        ),
        nextCursor: null,
      });
    if (path.endsWith("/preview-token")) {
      assert(path.includes(`/artifacts/${artifactId}/versions/${versionId}/`));
      return json(route, capability(true));
    }
    if (path.endsWith(`/artifacts/${artifactId}/versions/${versionId}`))
      return json(route, privateDetail);
    if (path.endsWith("/versions"))
      return json(route, {
        items: url.searchParams.has("cursor")
          ? [{ ...versionSummary, contentMode: "inline" }]
          : Array.from({ length: 30 }, (_, index) => ({
              ...versionSummary,
              artifactVersionId: `history-${index}`,
              contentMode: "inline",
              version: 35 - index,
            })),
        nextCursor: url.searchParams.has("cursor") ? null : "page-two",
      });
    if (path.endsWith("/relations"))
      return json(route, {
        version: {
          artifactId,
          artifactVersionId: versionId,
          version: 1,
          schemaVersion: 1,
          kind: "prototype",
          status: "ready",
          createdByRunId: null,
          title: content.title,
          prototypeRevision: null,
        },
        sourcePrd: null,
        derivedPrototypes: [],
        nextCursor: null,
      });
    if (
      ["/import-sources", "/artifacts", "/runs", "/releases", "/members"].some(
        (s) => path.endsWith(s),
      )
    )
      return json(route, { items: [], nextCursor: null });
  }
  unknown.push(path);
  return json(route, { status: 404, title: "Missing controlled route" }, 404);
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => errors.push(error.message));
const operate = async () => {
  const frame = page.frameLocator("iframe");
  await frame
    .getByRole("textbox", { name: "联系邮箱" })
    .fill("subscriber@example.test");
  await frame.getByRole("checkbox", { name: "接收通知" }).check();
  assert(await frame.getByRole("checkbox", { name: "接收通知" }).isChecked());
  await frame.getByRole("button", { name: "进入完成页", exact: true }).click();
  await frame.getByText("固定版本 1：订阅完成", { exact: true }).waitFor();
  await frame.getByRole("tab", { name: "Screen A", exact: true }).click();
  await frame
    .getByRole("button", { name: "进入完成页", exact: true })
    .waitFor();
};
const results: any = {
  evidence:
    "Actual new frontend and real isolated PreviewService/export runtime, controlled authorization/database and API responses; not real-model or production acceptance",
  checks,
  unknown,
  errors,
  previewRequests,
};
try {
  await page.goto(`${origin}/share/${shareToken}`, {
    waitUntil: "networkidle",
  });
  await operate();
  assert.equal(await page.locator("iframe").count(), 1);
  assert(!(await page.locator("body").innerText()).includes("node-root-a"));
  assert(
    requests.every(
      (path) =>
        path.startsWith("/api/v1/public/") || path.startsWith("/api/auth/"),
    ),
  );
  checks.push(
    "non-empty fixed schemaVersion 1 project share auto-renders real isolated screens; text input, checkbox, navigate action and screen tabs operate without private requests",
  );
  await page.screenshot({
    path: new URL("published-prototype.png", output).pathname,
  });
  state = "revoked";
  await page.getByRole("heading", { name: "分享已撤销" }).waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  checks.push(
    "revocation removes an actively displayed non-empty published prototype",
  );
  state = "active";
  await page.reload({ waitUntil: "networkidle" });
  await operate();
  state = "expired";
  await page.getByRole("heading", { name: "分享已过期" }).waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  checks.push(
    "expiry removes an actively displayed prototype after real controls and page navigation",
  );
  state = "active";
  authenticated = true;
  await context.addCookies([
    { name: "workbench.session_token", value: "fixture-session", url: origin },
  ]);
  await page.goto(
    `${origin}/studio/${projectId}?view=documents&artifact=${artifactId}&artifactVersion=${versionId}`,
    { waitUntil: "networkidle" },
  );
  await operate();
  assert.equal(
    await page.getByRole("combobox", { name: "文档版本" }).inputValue(),
    versionId,
  );
  await page.getByRole("button", { name: "加载更多版本", exact: true }).click();
  await page.getByText("已载入 31 个版本", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "文档版本" }).inputValue(),
    versionId,
  );
  checks.push(
    "private documents use the same interactive IR renderer and keep fixed version 1 when current artifact is version 2 and more history loads",
  );
  await page.reload({ waitUntil: "networkidle" });
  await operate();
  checks.push(
    "fixed artifact/version preview survives direct navigation and refresh",
  );
  await page.screenshot({
    path: new URL("private-prototype.png", output).pathname,
  });
  await page
    .getByRole("combobox", { name: "选择文档" })
    .selectOption("image-one");
  await page.getByText("文件未通过读取或完整性校验。").waitFor();
  assert.equal(await page.getByRole("img", { name: "项目图片" }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "下载原文件", exact: true }).count(),
    0,
  );
  corruptImage = false;
  await page.getByRole("button", { name: "重新读取文件" }).click();
  await page.getByRole("img", { name: "项目图片" }).waitFor();
  await page.waitForFunction(
    () => document.querySelector("img.studio-media")?.naturalWidth === 1,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载原文件", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "reference.png");
  checks.push(
    "image artifacts render and download only after byte-size and SHA-256 verification; equal-size corruption is blocked and an explicit retry succeeds",
  );
  await page.goBack();
  await operate();
  assert.equal(
    await page.getByRole("combobox", { name: "选择文档" }).inputValue(),
    artifactId,
  );
  await page.goForward();
  await page.getByRole("img", { name: "项目图片" }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "选择文档" }).inputValue(),
    "image-one",
  );
  checks.push(
    "native Back/Forward restores the actual selected artifact and its content after switching between prototype and media",
  );
  assert.deepEqual(unknown, []);
  assert.deepEqual(errors, []);
  results.status = "passed";
  await page.screenshot({
    path: new URL("media-preview.png", output).pathname,
  });
} catch (error) {
  results.status = "failed";
  results.failure = String(error);
  results.body = (await page.locator("body").innerText()).slice(0, 5000);
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
