import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const origin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const timestamp = "2026-07-15T05:00:00.000Z";
const sha256 = "a".repeat(64);
const outputDir = fileURLToPath(new URL("../../output/audit/1.0.0/browser-remediation/", import.meta.url));
const screenshot = path.join(outputDir, "workbench-export-recovery-1501x855.png");
const mobileScreenshot = path.join(outputDir, "workbench-export-recovery-390x844.png");
const unknownRequests = [];
const consoleErrors = [];
let phase = "cancel";
let cancelCalls = 0;
let detailPolls = 0;
let contentDownloads = 0;
let deliveryPrepares = 0;
let deliveryConfirms = 0;
let deliveryPolls = 0;

const project = {
  id: "project-export-recovery",
  workspaceId: "workspace-1",
  title: "Export Recovery Project",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const thread = {
  id: "thread-export-recovery",
  projectId: project.id,
  title: "Export Recovery Thread",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const board = {
  id: "board-export-recovery",
  projectId: project.id,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 0.8 },
  nodes: [],
  edges: [],
};

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1501, height: 855 },
  });
  await context.addCookies([{
    name: "workbench.session_token",
    value: "export-recovery-session",
    url: origin,
  }]);

  await context.route("**/api/auth/**", async (route) => {
    await json(route, {
      session: {
        id: "session-export-recovery",
        token: "export-recovery-session",
        userId: "principal-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
        ipAddress: null,
        userAgent: "Playwright",
      },
      user: {
        id: "principal-1",
        name: "Export Reviewer",
        email: "export-reviewer@example.test",
        emailVerified: true,
        image: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  });

  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const requestPath = new URL(request.url()).pathname;
    const method = request.method();

    if (method === "GET" && requestPath === "/api/v1/identity/me") {
      return json(route, {
        id: "principal-1",
        issuer: "https://identity.example.test",
        subject: "export-reviewer",
        email: "export-reviewer@example.test",
        displayName: "Export Reviewer",
        defaultWorkspaceId: "workspace-1",
      });
    }
    if (method === "GET" && requestPath === "/api/v1/identity/preferences") {
      return json(route, {
        productUpdatesEmail: false,
        researchInvitations: false,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      }, { etag: '"0"' });
    }
    if (method === "GET" && requestPath === "/api/v1/runtime/models") {
      return json(route, { items: [{
        id: "model-1",
        displayName: "Workbench Model",
        description: null,
        supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
        supportsThinking: true,
        supportsReasoningEffort: false,
      }] });
    }
    if (method === "GET" && requestPath === "/api/v1/design-presets") {
      return json(route, { items: [] });
    }
    if (method === "GET" && requestPath === "/api/v1/projects") {
      return json(route, {
        items: [{ ...project, role: "owner", relationship: "owned" }],
        nextCursor: null,
      });
    }
    if (method === "GET" && requestPath === "/api/v1/workspaces/workspace-1/design-systems") {
      return json(route, { items: [], nextCursor: null });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/import-sources`) {
      return json(route, { items: [], nextCursor: null });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/bootstrap`) {
      return json(route, {
        project,
        access: { role: "owner" },
        threads: [thread],
        selectedThreadId: thread.id,
        entries: [],
        board,
        artifacts: [],
        latestRun: null,
      }, { etag: '"1"' });
    }
    if (method === "GET" && requestPath === `/api/v1/threads/${thread.id}/submission-intents/current`) {
      return json(route, { item: null });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/board`) {
      return json(route, board, { etag: '"1"' });
    }
    if (method === "PUT" && requestPath === `/api/v1/projects/${project.id}/board`) {
      assert(request.headers()["if-match"] === '"1"', "Board autosave must use the current revision ETag");
      return json(route, {
        ...board,
        ...request.postDataJSON(),
        id: board.id,
        projectId: board.projectId,
      }, { etag: '"1"' });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/releases`) {
      return json(route, { items: [], nextCursor: null });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/shares`) {
      return json(route, { items: [], activeCount: 0, nextCursor: null });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/exports`) {
      return json(route, {
        items: [phase === "cancel"
          ? queuedExport()
          : phase === "download"
            ? runningExport()
            : succeededExternalExport()],
        nextCursor: null,
      });
    }
    if (method === "GET" && requestPath === "/api/v1/exports/capabilities") {
      const available = { available: true, authentication: "not_required", reasonCode: null };
      return json(route, {
        formats: {
          html: available,
          react: available,
          figma: { available: false, authentication: "not_required", reasonCode: "EXPORT_FIGMA_UNAVAILABLE" },
          mcp: available,
          docx: available,
          pdf: available,
        },
        packaging: { single_file: available, zip: available },
        external: {
          ai_studio: { available: false, authentication: "not_required", reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE" },
          netlify: { available: true, authentication: "authenticated", reasonCode: null },
          lovable: { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" },
          bolt: { available: false, authentication: "required", reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" },
        },
      });
    }
    if (method === "GET" && requestPath === "/api/v1/exports/export-cancel") {
      return json(route, queuedExport(), { etag: '"0"' });
    }
    if (method === "POST" && requestPath === "/api/v1/exports/export-cancel/cancel") {
      assert(request.headers()["if-match"] === '"0"', "Cancel must use the restored revision ETag");
      cancelCalls += 1;
      return json(route, cancelledExport(), { etag: '"1"' });
    }
    if (method === "GET" && requestPath === "/api/v1/exports/export-download") {
      detailPolls += 1;
      const job = detailPolls >= 2 ? succeededExport() : runningExport();
      return json(route, job, { etag: `"${job.revision}"` });
    }
    if (method === "GET" && requestPath === "/api/v1/exports/export-download/content") {
      contentDownloads += 1;
      return route.fulfill({
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="workbench-export-export-download.zip"',
          "content-type": "application/zip",
          etag: `"${sha256}"`,
        },
        body: "PK\u0003\u0004workbench-export",
      });
    }
    if (method === "GET" && requestPath === "/api/v1/exports/export-external") {
      return json(route, succeededExternalExport(), { etag: '"2"' });
    }
    if (
      method === "GET"
      && /^\/api\/v1\/exports\/export-(?:cancel|download|external)\/deliveries$/u.test(requestPath)
    ) {
      return json(route, { items: [] });
    }
    if (method === "POST" && requestPath === "/api/v1/exports/export-external/deliveries") {
      assert(request.headers()["idempotency-key"], "External delivery preparation requires Idempotency-Key");
      assert(request.postDataJSON().target === "netlify", "External delivery must bind the selected Netlify target");
      deliveryPrepares += 1;
      return json(route, pendingExternalDelivery(), {
        etag: '"0"',
        location: "/api/v1/export-deliveries/delivery-netlify",
      }, 201);
    }
    if (method === "POST" && requestPath === "/api/v1/export-deliveries/delivery-netlify/confirm") {
      assert(request.headers()["if-match"] === '"0"', "External confirmation must use the prepared delivery revision");
      deliveryConfirms += 1;
      return json(route, queuedExternalDelivery(), { etag: '"1"' }, 202);
    }
    if (method === "GET" && requestPath === "/api/v1/export-deliveries/delivery-netlify") {
      deliveryPolls += 1;
      const delivery = deliveryPolls >= 2 ? succeededExternalDelivery() : runningExternalDelivery();
      return json(route, delivery, { etag: `"${delivery.revision}"` });
    }

    unknownRequests.push(`${method} ${requestPath}`);
    return json(route, {
      type: "about:blank",
      title: "Unhandled browser fixture request",
      status: 404,
      code: "FIXTURE_ROUTE_MISSING",
    }, {}, 404);
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(`${message.text()} @ ${JSON.stringify(message.location())}`);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`${origin}/projects/${project.id}`, { waitUntil: "networkidle" });
  assert(await page.title() === "产品工作台", "browser title must use 产品工作台");
  await page.locator("[data-workbench-project]").waitFor();
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  const exportPanel = page.locator("[data-workbench-export-panel]");
  await exportPanel.waitFor();
  await exportPanel.getByRole("button", { name: "取消导出 Download .zip" }).click();
  await waitForValue(() => cancelCalls === 1, page, "restored Export cancellation");

  phase = "download";
  detailPolls = 0;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-workbench-project]").waitFor();
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  const downloadButton = page.locator("[data-workbench-export-panel]")
    .getByRole("button", { name: "下载 Download .zip" });
  await downloadButton.waitFor({ timeout: 8_000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;
  assert(
    download.suggestedFilename().endsWith(".zip"),
    `Recovered Export download must use a ZIP filename: ${download.suggestedFilename()}`,
  );

  phase = "external";
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-workbench-project]").waitFor();
  await page.locator("button[data-global-panel-trigger]").filter({ hasText: "导出" }).click();
  const externalPanel = page.locator("[data-workbench-export-panel]");
  await externalPanel.getByRole("button", { name: /Netlify/ }).click();
  await externalPanel.getByRole("button", { name: "准备发布至 Netlify" }).click();
  await externalPanel.getByText("workbench-export-export-external.zip").waitFor();
  assert(deliveryPrepares === 1, `External delivery must be prepared exactly once; prepares=${deliveryPrepares}`);
  assert(deliveryConfirms === 0, "Preparing an external delivery must not publish before explicit confirmation");
  await externalPanel.getByRole("button", { name: "确认发布至 Netlify" }).click();
  await waitForValue(() => deliveryConfirms === 1, page, "external delivery confirmation");
  await externalPanel.getByRole("button", { name: "已发布至 Netlify" }).waitFor({ timeout: 8_000 });
  await page.screenshot({ path: screenshot, animations: "disabled", caret: "hide", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await assertWithinViewport(page, externalPanel, "mobile Export panel");
  await page.screenshot({
    path: mobileScreenshot,
    animations: "disabled",
    caret: "hide",
    fullPage: true,
  });

  assert(detailPolls >= 2, `Active Export must be polled to terminal state; polls=${detailPolls}`);
  assert(contentDownloads === 1, `Successful Export must download exactly once; downloads=${contentDownloads}`);
  assert(deliveryPolls >= 2, `Confirmed external delivery must poll to terminal state; polls=${deliveryPolls}`);
  assert(unknownRequests.length === 0, `Unhandled API requests: ${unknownRequests.join(", ")}`);
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);

  console.log(JSON.stringify({
    ok: true,
    cancelCalls,
    detailPolls,
    contentDownloads,
    deliveryPrepares,
    deliveryConfirms,
    deliveryPolls,
    suggestedFilename: download.suggestedFilename(),
    screenshot: path.relative(fileURLToPath(new URL("../../", import.meta.url)), screenshot),
    mobileScreenshot: path.relative(fileURLToPath(new URL("../../", import.meta.url)), mobileScreenshot),
  }, null, 2));
} finally {
  await browser.close();
}

function queuedExport() {
  return exportJob({ id: "export-cancel", status: "queued", revision: 0 });
}

function cancelledExport() {
  return exportJob({
    id: "export-cancel",
    status: "cancelled",
    revision: 1,
    finishedAt: timestamp,
  });
}

function runningExport() {
  return exportJob({
    id: "export-download",
    status: "running",
    revision: 1,
    startedAt: timestamp,
  });
}

function succeededExport() {
  return exportJob({
    id: "export-download",
    status: "succeeded",
    revision: 2,
    startedAt: timestamp,
    finishedAt: timestamp,
    output: {
      blobId: "blob-export-download",
      mediaType: "application/zip",
      byteSize: 52,
      sha256,
      fileName: "workbench-export-export-download.zip",
    },
  });
}

function succeededExternalExport() {
  return exportJob({
    id: "export-external",
    status: "succeeded",
    revision: 2,
    startedAt: timestamp,
    finishedAt: timestamp,
    output: {
      blobId: "blob-export-external",
      mediaType: "application/zip",
      byteSize: 2_048,
      sha256,
      fileName: "workbench-export-export-external.zip",
    },
  });
}

function pendingExternalDelivery() {
  return externalDelivery({ status: "pending_confirmation", revision: 0 });
}

function queuedExternalDelivery() {
  return externalDelivery({
    status: "queued",
    revision: 1,
    confirmedAt: timestamp,
  });
}

function runningExternalDelivery() {
  return externalDelivery({
    status: "running",
    revision: 2,
    attempt: 1,
    confirmedAt: timestamp,
    startedAt: timestamp,
  });
}

function succeededExternalDelivery() {
  return externalDelivery({
    status: "succeeded",
    revision: 3,
    attempt: 1,
    remoteReference: "netlify-site-export-external",
    confirmedAt: timestamp,
    startedAt: timestamp,
    transferAuthorizedAt: timestamp,
    finishedAt: timestamp,
  });
}

function externalDelivery(overrides) {
  return {
    id: "delivery-netlify",
    exportJobId: "export-external",
    createdById: "principal-1",
    target: "netlify",
    authentication: "authenticated",
    status: "pending_confirmation",
    revision: 0,
    attempt: 0,
    payload: {
      exportJobId: "export-external",
      releaseId: "release-1",
      format: "html",
      packaging: "zip",
      selection: { kind: "board" },
      output: {
        mediaType: "application/zip",
        byteSize: 2_048,
        sha256,
        fileName: "workbench-export-export-external.zip",
      },
    },
    remoteReference: null,
    failure: null,
    createdAt: timestamp,
    confirmedAt: null,
    startedAt: null,
    transferAuthorizedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
    ...overrides,
  };
}

function exportJob(overrides) {
  return {
    id: "export-default",
    releaseId: "release-1",
    createdById: "principal-1",
    format: "html",
    packaging: "zip",
    selection: { kind: "board" },
    status: "queued",
    revision: 0,
    options: {},
    output: null,
    failure: null,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function waitForValue(predicate, page, label) {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < 8_000) {
    await page.waitForTimeout(50);
  }
  assert(predicate(), `${label} did not reach the expected state`);
}

async function assertWithinViewport(page, locator, label) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert(box && viewport, `${label} must have a measurable viewport box`);
  assert(
    box.x >= 0
      && box.y >= 0
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1,
    `${label} must remain inside ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`,
  );
}

async function json(route, body, headers = {}, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers,
    body: JSON.stringify(body),
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedOrigin(value, name) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without a path, query, or fragment`);
  }
  return url.origin;
}
