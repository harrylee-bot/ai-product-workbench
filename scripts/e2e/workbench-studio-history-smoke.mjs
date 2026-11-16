// Real Studio UI with strict, paginated HTTP fixtures; not real-model acceptance.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  artifactSchema,
  artifactVersionDetailSchema,
  importSourceSchema,
  projectBootstrapSchema,
  runSchema,
  threadSchema,
  threadEntrySchema,
} from "@workbench/workbench-contracts";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  "../../output/audit/1.0.0/studio-history/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-16T00:00:00Z",
  projectId = "history-project";
const project = {
  id: projectId,
  workspaceId: "workspace-1",
  title: "完整历史验证",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const threads = Array.from({ length: 35 }, (_, i) =>
  threadSchema.parse({
    id: `thread-${i}`,
    projectId,
    title: `对话 ${i}`,
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }),
);
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const checksum = createHash("sha256").update(imageBytes).digest("hex");
const artifacts = Array.from({ length: 35 }, (_, i) =>
  artifactSchema.parse({
    id: `image-${i}`,
    projectId,
    title: `资料图片 ${i}`,
    kind: "image",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    currentVersion: {
      artifactId: `image-${i}`,
      artifactVersionId: `image-v-${i}`,
      version: 1,
      kind: "image",
      schemaVersion: 1,
      status: "ready",
      checksum,
      createdByRunId: null,
      createdAt: now,
    },
  }),
);
const detail = (a) =>
  artifactVersionDetailSchema.parse({
    ...a.currentVersion,
    contentMode: "blob",
    citations: [],
    knowledgeReleaseId: null,
    sourcePrdVersionId: null,
    blob: {
      blobId: `blob-${a.id}`,
      fileName: `${a.id}.png`,
      mediaType: "image/png",
      byteSize: imageBytes.length,
      sha256: checksum,
    },
  });
const runs = (threadId) =>
  Array.from({ length: 35 }, (_, i) =>
    runSchema.parse({
      id: `${threadId}-run-${i}`,
      requestId: `${threadId}-request-${i}`,
      projectId,
      threadId,
      retryOfRunId: null,
      status: "succeeded",
      modelId: "fixture-model",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: ["prd"],
      sources: [],
      knowledgeReleaseId: null,
      phase: null,
      phaseLabel: null,
      progress: 1,
      attempt: 1,
      lastEventSequence: 0,
      cancelRequestedAt: null,
      failure: null,
      cancellationReason: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    }),
  );
const entries = (threadId) =>
  Array.from({ length: 105 }, (_, i) =>
    threadEntrySchema.parse({
      id: `${threadId}-entry-${i}`,
      threadId,
      sequence: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      kind: "message",
      content: {
        protocol: "workbench.entry.v1",
        type: i % 2 === 0 ? "user.prompt" : "assistant.message",
        text:
          i === 0
            ? `${threadId} 最初的用户需求`
            : `${threadId} 历史消息 ${i + 1}`,
        ...(i % 2 === 0 ? { sourceIds: [] } : {}),
      },
      producedByRunId: i % 2 === 0 ? null : `${threadId}-run-0`,
      createdAt: now,
    }),
  );
const sources = Array.from({ length: 35 }, (_, i) =>
  importSourceSchema.parse({
    id: `source-${i}`,
    projectId,
    createdById: "viewer-1",
    kind: "url_snapshot",
    status: "ready",
    label: `资料来源 ${i}`,
    descriptor: {
      kind: "url_snapshot",
      sourceUrl: `https://example.test/${i}`,
      resolvedUrl: `https://example.test/${i}`,
    },
    checksum,
    revision: 1,
    failure: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }),
);
const bootstrap = projectBootstrapSchema.parse({
  project,
  access: { role: "viewer" },
  threads: threads.slice(0, 1),
  selectedThreadId: "thread-0",
  entries: [],
  board: {
    id: "board-1",
    projectId,
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  },
  artifacts: artifacts.slice(0, 1),
  latestRun: null,
});
const results = {
  evidence:
    "Real Studio UI with controlled paginated HTTP fixtures, not real model acceptance",
  checks: [],
  errors: [],
  unknown: [],
  requests: [],
};
let artifactPageFails = true;
const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { etag: '"1"' },
    body: JSON.stringify(body),
  });
const pageOf = (items, url) => ({
  items: url.searchParams.has("cursor") ? items.slice(29) : items.slice(0, 30),
  nextCursor: url.searchParams.has("cursor") ? null : "page-two",
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([
  { name: "workbench.session_token", value: "history-fixture", url: origin },
]);
await context.route("**/api/**", async (route) => {
  const url = new URL(route.request().url()),
    path = url.pathname;
  results.requests.push(path + url.search);
  if (path === "/api/auth/get-session")
    return json(route, {
      session: {
        id: "session",
        token: "history-fixture",
        userId: "viewer-1",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: now,
        updatedAt: now,
      },
      user: {
        id: "viewer-1",
        name: "历史验收",
        email: "viewer@example.test",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  if (path.endsWith("/artifact-links"))
    return json(route, { items: [], nextCursor: null });
  if (path.endsWith("/identity/me"))
    return json(route, {
      id: "viewer-1",
      issuer: "https://identity.example.test",
      subject: "viewer",
      email: "viewer@example.test",
      displayName: "历史验收",
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
  if (path.endsWith("/bootstrap")) return json(route, bootstrap);
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
  if (path === `/api/v1/projects/${projectId}/artifacts`) {
    assert.equal(url.searchParams.get("limit"), "30");
    if (url.searchParams.has("cursor") && artifactPageFails)
      return json(
        route,
        {
          status: 503,
          title: "Temporarily unavailable",
          type: "about:blank",
          code: "SERVICE_UNAVAILABLE",
        },
        503,
      );
    return json(
      route,
      pageOf(
        !url.searchParams.has("kind") ||
          url.searchParams.get("kind") === "image"
          ? artifacts
          : [],
        url,
      ),
    );
  }
  const a = artifacts.find(
    (a) =>
      path.startsWith(`/api/v1/artifacts/${a.id}/`) ||
      path === `/api/v1/artifacts/${a.id}`,
  );
  if (a) {
    if (path.endsWith("/content"))
      return route.fulfill({ contentType: "image/png", body: imageBytes });
    if (path.endsWith("/versions"))
      return json(route, {
        items: [{ ...a.currentVersion, contentMode: "blob" }],
        nextCursor: null,
      });
    if (path.includes("/versions/")) return json(route, detail(a));
    return json(route, a);
  }
  if (path === `/api/v1/projects/${projectId}/threads`) {
    assert.equal(url.searchParams.get("limit"), "30");
    return json(route, pageOf(threads, url));
  }
  if (path === `/api/v1/threads/foreign-thread`)
    return json(route, {
      ...threads[0],
      id: "foreign-thread",
      projectId: "other-project",
    });
  const t = threads.find(
    (t) =>
      path === `/api/v1/threads/${t.id}` ||
      path.startsWith(`/api/v1/threads/${t.id}/`),
  );
  if (t) {
    if (path.endsWith("/runs")) {
      assert.equal(url.searchParams.get("limit"), "30");
      return json(route, pageOf(runs(t.id), url));
    }
    if (path.endsWith("/entries")) {
      assert.equal(url.searchParams.get("limit"), "100");
      const after = Number(url.searchParams.get("afterSequence"));
      return json(route, {
        items: entries(t.id)
          .filter((e) => e.sequence > after)
          .slice(0, 100),
        nextAfterSequence: after === 0 ? 100 : null,
      });
    }
    return json(route, t);
  }
  const run = threads
    .flatMap((t) => runs(t.id))
    .find(
      (r) =>
        path === `/api/v1/runs/${r.id}` ||
        path.startsWith(`/api/v1/runs/${r.id}/`),
    );
  if (run) {
    if (path.endsWith("/outputs"))
      return json(route, {
        projectId,
        runId: run.id,
        status: run.status,
        coverage: "complete",
        items: [{ kind: "prd", state: "unpublished", version: null }],
      });
    if (path.endsWith("/approvals")) return json(route, { items: [] });
    return json(route, run);
  }
  if (path.endsWith("/import-sources"))
    return json(route, pageOf(sources, url));
  if (path.endsWith("/design-systems") || path.endsWith("/releases"))
    return json(route, { items: [], nextCursor: null });
  results.unknown.push(`${route.request().method()} ${path}`);
  return json(route, { status: 404, title: "Fixture route missing" }, 404);
});
const page = await context.newPage();
page.on("pageerror", (error) => results.errors.push(error.message));
const check = async (predicate, message) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await page.waitForTimeout(100);
  }
  throw Error(message);
};
try {
  await page.goto(
    `${origin}/studio/${projectId}?view=documents&artifact=image-0`,
    { waitUntil: "networkidle" },
  );
  await check(
    async () =>
      (await page.getByLabel("选择文档").locator("option").count()) === 30,
    "first artifact page",
  );
  await page.getByRole("button", { name: "加载更多产物", exact: true }).click();
  await page
    .getByRole("button", { name: "重试产物目录", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("选择文档").inputValue(), "image-0");
  artifactPageFails = false;
  await page.getByRole("button", { name: "加载更多产物", exact: true }).click();
  await check(
    async () =>
      (await page.getByLabel("选择文档").locator("option").count()) === 35,
    "deduplicated artifact pages",
  );
  await page.getByLabel("选择文档").selectOption("image-34");
  await page.getByRole("img", { name: "资料图片 34", exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("img", { name: "资料图片 34", exact: true }).waitFor();
  assert.equal(await page.getByLabel("选择文档").inputValue(), "image-34");
  await page.getByLabel("产物类型").selectOption("prd");
  await page.getByRole("img", { name: "资料图片 34", exact: true }).waitFor();
  assert.equal(await page.getByLabel("选择文档").inputValue(), "image-34");
  results.checks.push(
    "artifact cursor pagination deduplicates overlaps; failure retains selection, retry works, fixed historical artifact survives reload and filter",
  );
  await page.goto(`${origin}/studio/${projectId}?view=runs`, {
    waitUntil: "networkidle",
  });
  await page.getByText("thread-0 最初的用户需求", { exact: true }).waitFor();
  const history = page.getByRole("region", { name: "完整对话历史" });
  assert.equal(await history.locator("article").count(), 100);
  await page.getByRole("button", { name: "加载后续消息", exact: true }).click();
  await check(
    async () => (await history.locator("article").count()) === 105,
    "all 105 entries",
  );
  assert.equal(
    await history.getByText("thread-0 最初的用户需求", { exact: true }).count(),
    1,
  );
  results.checks.push(
    "complete sequential conversation includes unbound initial user prompt and all 105 paginated entries without duplication",
  );
  await page.getByRole("button", { name: "加载更多运行", exact: true }).click();
  await check(
    async () =>
      (await page
        .getByLabel("运行记录", { exact: true })
        .locator("option")
        .count()) === 35,
    "all run pages",
  );
  await page
    .getByLabel("运行记录", { exact: true })
    .selectOption("thread-0-run-34");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(
    await page.getByLabel("运行记录", { exact: true }).inputValue(),
    "thread-0-run-34",
  );
  results.checks.push(
    "historical Run beyond first page remains pinned after direct refresh without drift to newest Run",
  );
  await page.getByRole("button", { name: "加载更多对话", exact: true }).click();
  await check(
    async () =>
      (await page
        .getByLabel("对话", { exact: true })
        .locator("option")
        .count()) === 35,
    "all threads",
  );
  await page.getByLabel("对话", { exact: true }).selectOption("thread-34");
  await page.getByText("thread-34 最初的用户需求", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("thread-0 最初的用户需求", { exact: true }).count(),
    0,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("thread-34 最初的用户需求", { exact: true }).waitFor();
  await page.screenshot({
    path: new URL("complete-history.png", output).pathname,
  });
  results.checks.push(
    "paginated thread selection persists in URL; refresh validates missing-page thread and never mixes conversation messages",
  );
  await page.goto(
    `${origin}/studio/${projectId}?view=runs&thread=foreign-thread`,
    { waitUntil: "networkidle" },
  );
  await page.getByText("此对话不属于当前项目", { exact: false }).waitFor();
  assert(
    !results.requests.some((url) =>
      /foreign-thread\/(?:entries|runs)/.test(url),
    ),
  );
  assert.equal(
    await page.getByRole("region", { name: "完整对话历史" }).count(),
    0,
  );
  results.checks.push(
    "cross-project fixed thread is rejected before requesting its messages or runs",
  );
  await page.goto(`${origin}/studio/${projectId}?view=resources`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "加载更多资料", exact: true }).click();
  await page
    .getByRole("heading", { name: "资料来源 34", exact: true })
    .waitFor();
  assert.equal(await page.locator(".studio-resource-list article").count(), 35);
  results.checks.push(
    "resources use cursor pagination and deduplicate overlapping pages",
  );
  assert.deepEqual(results.unknown, []);
  assert.deepEqual(results.errors, []);
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
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ status: results.status, checks: results.checks }));
