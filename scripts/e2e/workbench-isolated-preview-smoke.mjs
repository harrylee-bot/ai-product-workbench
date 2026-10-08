import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { injectWorkbenchPreviewBridge } from "../../apps/workbench-preview/dist/preview-bridge.js";

const webOrigin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const previewOrigin = normalizedOrigin(
  process.env.WORKBENCH_E2E_PREVIEW_ORIGIN ?? "http://127.0.0.1:4300",
  "WORKBENCH_E2E_PREVIEW_ORIGIN",
);
const timestamp = "2026-07-13T12:00:00.000Z";
const checksum = "a".repeat(64);
const unknownRequests = [];
const handledRequests = [];
const consoleErrors = [];
const previewRequests = [];
const requestFailures = [];
const projectPreviews = new Map();
const previewHtml = await readFile(
  new URL("./fixtures/preview-origin/preview/capability.html", import.meta.url),
  "utf8",
);
let projectPreviewCount = 0;
let previewTokenCount = 0;

const project = {
  id: "project-1",
  workspaceId: "workspace-1",
  title: "Isolated Preview Project",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const artifactPins = [1, 2].map((position) => ({
  position: position - 1,
  artifactId: `artifact-${position}`,
  artifactVersionId: `version-${position}`,
  screenId: `screen-${position}`,
  title: position === 1 ? "First Screen" : "Second Screen",
  kind: "prototype",
  version: 1,
  schemaVersion: 1,
  checksum,
  assets: [],
}));

const board = {
  id: "board-1",
  projectId: project.id,
  revision: 1,
  viewport: { x: 310, y: 90, zoom: 0.63 },
  nodes: artifactPins.map((pin, index) => ({
    id: `node-${index + 1}`,
    kind: "artifact",
    parentNodeId: null,
    order: index,
    position: { x: 90 + index * 460, y: 120 },
    size: { width: 360, height: 640 },
    artifactId: pin.artifactId,
    artifactVersionId: pin.artifactVersionId,
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "artifact",
      artifactKind: "prototype",
      screenId: pin.screenId,
      route: index === 0 ? "/" : `/screen-${index + 1}`,
      title: pin.title,
    },
  })),
  edges: [],
};

const artifacts = artifactPins.map((pin) => ({
  id: pin.artifactId,
  projectId: project.id,
  kind: "prototype",
  title: pin.title,
  revision: 1,
  currentVersion: {
    artifactId: pin.artifactId,
    artifactVersionId: pin.artifactVersionId,
    version: 1,
    kind: "prototype",
    schemaVersion: 1,
    status: "ready",
    checksum,
    createdByRunId: null,
    createdAt: timestamp,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
}));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1501, height: 855 } });
await context.addCookies([{
  name: "workbench.session_token",
  value: "preview-smoke-session",
  url: webOrigin,
}]);

await context.route(`${previewOrigin}/preview/**`, async (route) => {
  const requestUrl = route.request().url();
  previewRequests.push(requestUrl);
  const capabilityId = new URL(requestUrl).pathname.slice("/preview/".length);
  const bridgedPreview = injectWorkbenchPreviewBridge(previewHtml, webOrigin, capabilityId);
  await route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
    body: bridgedPreview.html,
  });
});

await context.route("**/api/auth/**", async (route) => {
  await json(route, {
    session: {
      id: "session-1",
      token: "preview-smoke-session",
      userId: "principal-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp,
      ipAddress: null,
      userAgent: "Playwright",
    },
    user: {
      id: "principal-1",
      name: "Preview Viewer",
      email: "preview@example.test",
      emailVerified: true,
      image: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
});

await context.route("**/api/v1/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  handledRequests.push(`${method} ${path}`);

  if (method === "GET" && path === "/api/v1/identity/me") {
    return json(route, {
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "preview-reviewer",
      email: "preview@example.test",
      displayName: "Preview Viewer",
      defaultWorkspaceId: "workspace-1",
    });
  }
  if (method === "GET" && path === "/api/v1/identity/preferences") {
    return json(route, {
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    }, { etag: '"0"' });
  }
  if (method === "GET" && path === "/api/v1/runtime/models") {
    return json(route, { items: [{
      id: "model-1",
      displayName: "Workbench Model",
      description: null,
      supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
      supportsThinking: true,
      supportsReasoningEffort: false,
    }] });
  }
  if (method === "GET" && path === "/api/v1/design-presets") {
    return json(route, { items: [] });
  }
  if (method === "GET" && path === "/api/v1/projects") {
    return json(route, { items: [{ ...project, role: "viewer", relationship: "shared" }], nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/workspaces/workspace-1/design-systems") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/import-sources") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/bootstrap") {
    return json(route, {
      project,
      access: { role: "viewer" },
      threads: [],
      selectedThreadId: null,
      entries: [],
      board,
      artifacts,
      latestRun: null,
    }, { etag: '"1"' });
  }
  const artifactMatch = path.match(/^\/api\/v1\/artifacts\/(artifact-\d+)$/u);
  if (method === "GET" && artifactMatch) {
    const artifact = artifacts.find((candidate) => candidate.id === artifactMatch[1]);
    if (artifact) return json(route, artifact, { etag: '"1"' });
  }
  const artifactPreferenceMatch = path.match(
    /^\/api\/v1\/artifacts\/(artifact-\d+)\/versions\/(version-\d+)\/preference$/u,
  );
  if (method === "GET" && artifactPreferenceMatch) {
    const screenId = url.searchParams.get("screenId");
    assert(screenId !== null, "Artifact preference reads must remain screen-scoped");
    return json(route, {
      artifactId: artifactPreferenceMatch[1],
      artifactVersionId: artifactPreferenceMatch[2],
      screenId,
      favorite: false,
      reaction: null,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    }, { etag: '"0"' });
  }
  const artifactVersionMatch = path.match(
    /^\/api\/v1\/artifacts\/(artifact-\d+)\/versions\/(version-\d+)$/,
  );
  if (method === "GET" && artifactVersionMatch) {
    const artifact = artifacts.find((candidate) => (
      candidate.id === artifactVersionMatch[1]
      && candidate.currentVersion.artifactVersionId === artifactVersionMatch[2]
    ));
    if (artifact) {
      return json(route, {
        ...artifact.currentVersion,
        citations: [],
        knowledgeReleaseId: null,
        contentMode: "inline",
        content: prototypeDocument(Number(artifact.id.slice("artifact-".length))),
      }, { etag: `"${checksum}"` });
    }
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/board") {
    return json(route, board, { etag: '"1"' });
  }
  if (method === "GET" && path === "/api/v1/exports/capabilities") {
    const available = { available: true, authentication: "not_required", reasonCode: null };
    return json(route, {
      formats: {
        html: available,
        react: available,
        figma: {
          available: false,
          authentication: "not_required",
          reasonCode: "EXPORT_FIGMA_UNAVAILABLE",
        },
        mcp: available,
        docx: available,
        pdf: available,
      },
      packaging: { single_file: available, zip: available },
      external: {
        ai_studio: {
          available: false,
          authentication: "not_required",
          reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
        },
        netlify: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
        lovable: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
        bolt: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
      },
    });
  }
  if (method === "POST" && path === "/api/v1/projects/project-1/previews") {
    const requestBody = request.postDataJSON();
    assert(requestBody.boardId === board.id, "ProjectPreview must pin the persisted Board identity");
    assert(requestBody.boardRevision === board.revision, "ProjectPreview must pin the persisted Board revision");
    assert(!("screenId" in requestBody.selection), "ProjectPreview must retain the complete Prototype");
    const pin = artifactPins.find((candidate) => candidate.artifactId === requestBody.selection.artifactId);
    assert(pin && requestBody.initialScreenId === pin.screenId, "ProjectPreview must pin its initial screen separately");
    const id = `preview-${++projectPreviewCount}`;
    const preview = projectPreview(id, requestBody.selection, requestBody.initialScreenId);
    projectPreviews.set(id, preview);
    return json(route, preview, { location: `/api/v1/previews/${id}` }, 202);
  }
  const projectPreviewMatch = path.match(/^\/api\/v1\/previews\/(preview-\d+)$/);
  if (method === "GET" && projectPreviewMatch) {
    return json(route, projectPreviews.get(projectPreviewMatch[1]));
  }
  const previewTokenMatch = path.match(/^\/api\/v1\/previews\/(preview-\d+)\/token$/);
  if (method === "POST" && previewTokenMatch) {
    previewTokenCount += 1;
    return json(route, {
      url: `${previewOrigin}/preview/${previewTokenMatch[1]}-generation-${previewTokenCount}.html`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }

  unknownRequests.push(`${method} ${path}`);
  await json(route, {
    type: "about:blank",
    title: "Unhandled browser fixture request",
    status: 404,
    code: "FIXTURE_ROUTE_MISSING",
  }, {}, 404);
});

const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("requestfailed", (request) => {
  requestFailures.push(`${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`);
});

await page.goto(`${webOrigin}/projects/project-1?boardNode=node-1`, { waitUntil: "networkidle" });
assert(await page.title() === "产品工作台", "browser title must use 产品工作台");
await page.locator("[data-workbench-project]").waitFor();
assert(
  await page.getByRole("button", { name: "导出", exact: true }).isDisabled(),
  "Viewer must not receive the Export capability",
);
await page.getByRole("button", { name: "预览项目" }).click();

const overlay = page.locator("[data-project-preview]");
await overlay.waitFor();
const frame = overlay.locator("iframe[data-preview-capability]");
try {
  await frame.waitFor({ timeout: 8_000 });
} catch (error) {
  throw new Error(JSON.stringify({
    cause: error instanceof Error ? error.message : String(error),
    overlayText: await overlay.textContent(),
    handledRequests,
    unknownRequests,
    consoleErrors,
    previewRequests,
    requestFailures,
  }, null, 2));
}
await expectAttribute(frame, "src", "generation-1");
const sandbox = await frame.getAttribute("sandbox");
assert(sandbox?.includes("allow-scripts"), "Preview iframe must allow the fixed runtime script");
assert(!sandbox?.includes("allow-same-origin"), "Preview iframe must keep an opaque origin");
assert(!sandbox?.includes("allow-top-navigation"), "Preview iframe must not navigate the Workbench");
assert((await frame.getAttribute("referrerpolicy")) === "no-referrer", "Preview iframe must not leak its capability URL through referrers");
assert(new URL(await frame.getAttribute("src")).origin === previewOrigin, "Preview must use the independent origin");

const isolatedFrame = page.frameLocator("iframe[data-preview-capability]");
let activePreviewFrame = await waitForPreviewFrame("generation-1");
await isolatedFrame.getByRole("heading", { name: "独立预览已加载" }).waitFor();
await verifyPreviewInteraction();
await expectSelectedDeviceViewport("手机", "mobile", 390, 844, activePreviewFrame);
await expectSelectedDeviceViewport("横屏", "phone-landscape", 844, 390, activePreviewFrame);
await expectSelectedDeviceViewport("平板", "tablet", 768, 1024, activePreviewFrame);
await expectSelectedDeviceViewport("桌面", "desktop", 1440, 900, activePreviewFrame);
await overlay.getByRole("button", { name: "响应式" }).click();
await expectResponsiveViewport(activePreviewFrame);
await overlay.getByRole("button", { name: "自定义" }).click();
await overlay.getByRole("spinbutton", { name: "自定义预览宽度" }).fill("1280");
await overlay.getByRole("spinbutton", { name: "自定义预览高度" }).fill("720");
await expectDeviceViewport("custom", 1280, 720, activePreviewFrame);
assert(previewTokenCount === 1, "Device changes must not recreate the Preview capability");

const qrTrigger = overlay.getByRole("button", { name: "二维码预览" });
assert(!(await qrTrigger.isDisabled()), "QR must be enabled only after the Preview handshake is ready");
await qrTrigger.click();
const qr = page.locator("[data-preview-qr]");
await qr.waitFor();
const qrBox = await qr.boundingBox();
assert(qrBox && qrBox.width >= 180 && qrBox.height >= 180, "Preview QR must render as a visible local code");
const capabilityLink = page.getByRole("link", { name: "在新窗口打开预览" });
const capabilityUrl = await capabilityLink.getAttribute("href");
assert(capabilityUrl === await frame.getAttribute("src"), "QR must encode the active short-lived Preview capability URL");
const topLevelConsoleErrors = [];
const [topLevelPreview] = await Promise.all([
  context.waitForEvent("page"),
  capabilityLink.click(),
]);
topLevelPreview.on("console", (message) => {
  if (message.type() === "error") topLevelConsoleErrors.push(message.text());
});
topLevelPreview.on("pageerror", (error) => topLevelConsoleErrors.push(error.message));
await topLevelPreview.waitForLoadState("load");
assert(await topLevelPreview.evaluate(() => window.opener === null), "Top-level Preview must not retain a Workbench opener");
await topLevelPreview.getByRole("heading", { name: "独立预览已加载" }).waitFor();
await topLevelPreview.getByRole("button", { name: "验证交互" }).click();
await topLevelPreview.getByText("交互已执行").waitFor();
assert(topLevelConsoleErrors.length === 0, `Top-level Preview console errors: ${topLevelConsoleErrors.join(" | ")}`);
await topLevelPreview.close();

await overlay.getByRole("button", { name: "Second Screen" }).click();
await expectAttribute(frame, "src", "preview-2");
await overlay.getByRole("button", { name: "刷新预览" }).click();
await expectAttribute(frame, "src", "generation-3");
activePreviewFrame = await waitForPreviewFrame("generation-3");
await isolatedFrame.getByRole("heading", { name: "独立预览已加载" }).waitFor();
await expectFrameViewport(activePreviewFrame, 1280, 720);

const overlayBox = await overlay.boundingBox();
const frameBox = await frame.boundingBox();
assert(overlayBox && overlayBox.width === 1501 && overlayBox.height === 855, "Preview Overlay must retain the full Workbench viewport");
assert(frameBox && frameBox.width > 200 && frameBox.height > 300, "Preview iframe must be visibly framed and non-empty");
await page.screenshot({
  path: "output/audit/1.0.0/browser-remediation/workbench-isolated-preview-desktop-1501x855.png",
  fullPage: true,
});

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(250);
await page.screenshot({
  path: "output/audit/1.0.0/browser-remediation/workbench-isolated-preview-mobile-390x844.png",
  fullPage: true,
});

assert(unknownRequests.length === 0, `Unhandled API fixture requests: ${unknownRequests.join(", ")}`);
assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);
assert(
  !handledRequests.some((request) => request.includes("/submission-intents")),
  "Viewer Preview without an active Thread must not query or mutate SubmissionIntent state",
);
assert(
  !handledRequests.some((request) => (
    request.includes("/projects/project-1/releases")
    || request.includes("/projects/project-1/exports")
    || (
      request.includes("/api/v1/exports/")
      && !request.includes("/api/v1/exports/capabilities")
    )
  )),
  "Viewer Preview must not call ProjectRelease or public Export job APIs",
);

console.log(JSON.stringify({
  ok: true,
  role: "viewer",
  releaseCount: 0,
  exportCount: 0,
  projectPreviewCount,
  previewTokenCount,
  sandbox,
  desktopScreenshot: "output/audit/1.0.0/browser-remediation/workbench-isolated-preview-desktop-1501x855.png",
  mobileScreenshot: "output/audit/1.0.0/browser-remediation/workbench-isolated-preview-mobile-390x844.png",
}, null, 2));

await browser.close();

function prototypeDocument(position) {
  const literal = (value) => ({ kind: "literal", value });
  const screenId = `screen-${position}`;
  const rootNodeId = `frame-${position}`;
  const actionId = `action-${position}`;
  return {
    protocol: "workbench.prototype.v1",
    documentId: `prototype-${position}`,
    title: position === 1 ? "First Screen" : "Second Screen",
    revision: 1,
    screens: [{
      id: screenId,
      name: position === 1 ? "First Screen" : "Second Screen",
      route: position === 1 ? "/" : `/screen-${position}`,
      rootNodeId,
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: rootNodeId,
      screenId,
      parentId: null,
      name: "Interactive preview root",
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "block",
        direction: "column",
        gap: literal(0),
        padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
        align: "stretch",
        justify: "start",
        gridColumns: null,
        overflow: "hidden",
      },
      style: {
        opacity: 1,
        rotation: 0,
        transformOrigin: { x: 0.5, y: 0.5 },
        fill: { kind: "literal", value: "#ffffff" },
        stroke: null,
        radii: {
          topLeft: literal(0),
          topRight: literal(0),
          bottomRight: literal(0),
          bottomLeft: literal(0),
        },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [actionId],
      bindingIds: [],
      motionIds: [],
      kind: "frame",
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [{
      id: actionId,
      nodeId: rootNodeId,
      event: "click",
      kind: "openUrl",
      url: "https://example.test/preview-action",
      target: "newWindow",
    }],
    bindings: [],
    motions: [],
  };
}

function projectPreview(id, selection, initialScreenId) {
  return {
    id,
    projectId: project.id,
    boardId: board.id,
    boardRevision: board.revision,
    selection,
    initialScreenId,
    status: "succeeded",
    revision: 0,
    failure: null,
    createdAt: timestamp,
    expiresAt: "2099-01-01T00:00:00.000Z",
    updatedAt: timestamp,
  };
}

async function json(route, body, headers = {}, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers,
    body: JSON.stringify(body),
  });
}

async function expectAttribute(locator, name, fragment) {
  await page.waitForFunction(
    ({ selector, name, fragment }) => document.querySelector(selector)?.getAttribute(name)?.includes(fragment),
    { selector: "[data-project-preview] iframe[data-preview-capability]", name, fragment },
  );
}

async function waitForPreviewFrame(urlFragment) {
  let previewFrame = null;
  for (let attempt = 0; attempt < 100 && !previewFrame; attempt += 1) {
    previewFrame = page.frames().find((candidate) => (
      candidate.parentFrame() === page.mainFrame()
      && candidate.url().includes(urlFragment)
    )) ?? null;
    if (!previewFrame) await page.waitForTimeout(25);
  }
  assert(previewFrame, `Preview frame ${urlFragment} was not attached; ${JSON.stringify({
    frames: page.frames().map((frame) => frame.url()),
    previewRequests,
    requestFailures,
  })}`);
  await previewFrame.waitForLoadState("load");
  return previewFrame;
}

async function expectSelectedDeviceViewport(label, mode, width, height, previewFrame) {
  await overlay.getByRole("button", { name: label }).click();
  await expectDeviceViewport(mode, width, height, previewFrame);
}

async function expectDeviceViewport(mode, width, height, previewFrame) {
  await page.waitForFunction(
    ({ mode, width, height }) => {
      const device = document.querySelector("[data-preview-device]");
      return device?.getAttribute("data-preview-device") === mode
        && device.getAttribute("data-preview-width") === String(width)
        && device.getAttribute("data-preview-height") === String(height);
    },
    { mode, width, height },
  );
  await expectFrameViewport(previewFrame, width, height);
}

async function expectResponsiveViewport(previewFrame) {
  const dimensions = await page.locator("[data-preview-device='responsive']").evaluate((element) => ({
    width: Number(element.getAttribute("data-preview-width")),
    height: Number(element.getAttribute("data-preview-height")),
  }));
  assert(dimensions.width > 300 && dimensions.height > 300, "Responsive Preview viewport must fill the available stage");
  await expectFrameViewport(previewFrame, dimensions.width, dimensions.height);
}

async function expectFrameViewport(previewFrame, width, height) {
  await page.waitForFunction(
    ({ width, height }) => {
      const frame = document.querySelector("iframe[data-preview-capability]");
      return frame?.clientWidth === width && frame.clientHeight === height;
    },
    { width, height },
  );
  const deadline = Date.now() + 2_000;
  let actual = await previewFrame.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  while ((actual.width !== width || actual.height !== height) && Date.now() < deadline) {
    await page.waitForTimeout(25);
    actual = await previewFrame.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }
  assert(
    actual.width === width && actual.height === height,
    `Preview runtime viewport mismatch: expected ${width}x${height}, received ${actual.width}x${actual.height}`,
  );
}

async function verifyPreviewInteraction() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await isolatedFrame.getByRole("heading", { name: "独立预览已加载" }).waitFor();
    // The iframe is intentionally CSS-scaled inside the device frame; invoke the
    // already-visible control in its own document to avoid an unscaled hit-test.
    await isolatedFrame.getByRole("button", { name: "验证交互" }).evaluate(
      (element) => element.click(),
    );
    try {
      await isolatedFrame.getByText("交互已执行").waitFor({ timeout: 2_000 });
      return;
    } catch {
      await page.waitForTimeout(100);
    }
  }
  throw new Error(`Preview interaction did not settle on the active capability frame: ${JSON.stringify({
    frames: page.frames().map((candidate) => candidate.url()),
    previewRequests,
    requestFailures,
    consoleErrors,
  })}`);
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
