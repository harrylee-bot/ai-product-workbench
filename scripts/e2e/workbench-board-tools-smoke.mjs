import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import { injectWorkbenchPreviewBridge } from "../../apps/workbench-preview/dist/preview-bridge.js";
import { previewContentSecurityPolicy } from "../../apps/workbench-preview/dist/csp.js";

async function shiftSelectNodeByKeyboard(locator, label) {
  await locator.waitFor({ state: "visible" });
  await locator.focus();
  assert(
    await locator.evaluate((element) => document.activeElement === element),
    `${label} must be focusable as a React Flow node`,
  );
  await page.keyboard.down("Shift");
  try {
    await page.keyboard.press("Enter");
  } finally {
    await page.keyboard.up("Shift");
  }
}

async function selectNodeByKeyboard(locator, label) {
  await locator.waitFor({ state: "visible" });
  await locator.focus();
  assert(
    await locator.evaluate((element) => document.activeElement === element),
    `${label} must be focusable as a React Flow node`,
  );
  await locator.press("Enter");
}

const origin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const previewOrigin = normalizedOrigin(
  process.env.WORKBENCH_E2E_PREVIEW_ORIGIN ?? "http://localhost:4101",
  "WORKBENCH_E2E_PREVIEW_ORIGIN",
);
const previewHtml = await readFile(
  new URL("./fixtures/preview-origin/preview/capability.html", import.meta.url),
  "utf8",
);
const timestamp = "2026-07-14T01:00:00.000Z";
const checksum = "a".repeat(64);
const preferenceEtag = (revision) => `"avp1.${revision}.${"a".repeat(43)}"`;
const projectBaselineScreenshot = "output/playwright/workbench-phase0-baseline-project-complete-1501x855.png";
const desktopFavouritesPanelScreenshot = "output/playwright/workbench-board-favourites-panel-desktop-1501x855.png";
const desktopDesignSystemPanelScreenshot = "output/playwright/workbench-board-design-system-panel-desktop-1501x855.png";
const mobileFavouritesPanelScreenshot = "output/playwright/workbench-board-favourites-panel-mobile-390x844.png";
const mobileDesignSystemPanelScreenshot = "output/playwright/workbench-board-design-system-panel-mobile-390x844.png";
const desktopScreenContextToolbarScreenshot = "output/playwright/workbench-screen-context-toolbar-desktop-1501x855.png";
const mobileScreenContextToolbarScreenshot = "output/playwright/workbench-screen-context-toolbar-mobile-390x844.png";
const fixedViewportMatrix = [
  { key: "mobile", width: 375, height: 812 },
  { key: "tablet", width: 768, height: 1024 },
  { key: "desktop", width: 1440, height: 900 },
];
const fixedViewportScreenshotPaths = Object.fromEntries(
  fixedViewportMatrix.map(({ key, width, height }) => [
    key,
    `output/playwright/workbench-phase11-${key}-${width}x${height}.png`,
  ]),
);
const homeMobileDrawerScreenshot = "output/playwright/workbench-phase11-home-drawer-mobile-375x812.png";
const unknownRequests = [];
const consoleErrors = [];
const saves = [];
const saveIdempotencyKeys = [];
const createdSubmissionIntentRequests = [];
const submittedIntentRunRequests = [];
const submittedSubmissionIntentIds = [];
const memberRoleUpdates = [];
const uploadCreateIdempotencyKeys = [];
const artifactPreferenceUpdates = [];
const artifactPreferenceIfMatches = [];
const stage2SaveCounts = {};
const projectPreviews = new Map();
const previewSelections = [];
let uploadSessionAttempts = 0;
let uploadedPartPuts = 0;
let uploadCompletionAttempts = 0;
let activeSubmissionIntent = null;
let artifactPreferenceReads = 0;
let artifactPreferencePutsInFlight = 0;
let maxArtifactPreferencePutsInFlight = 0;
let delayNextArtifactPreferencePut = false;
let projectPreviewCount = 0;
let previewTokenCount = 0;
let runnablePreviewEnabled = false;
let artifactPreference = {
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  screenId: "screen-home",
  favorite: false,
  reaction: null,
  revision: 0,
  createdAt: null,
  updatedAt: null,
};

const project = {
  id: "project-1",
  workspaceId: "workspace-1",
  title: "Board Tools Project",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const thread = {
  id: "thread-1",
  projectId: project.id,
  title: "Board Tools Thread",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const completedRun = {
  id: "run-phase0-complete",
  requestId: "request-phase0-complete",
  projectId: project.id,
  threadId: thread.id,
  retryOfRunId: null,
  status: "succeeded",
  modelId: "model-1",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: ["prototype"],
  sources: [],
  knowledgeReleaseId: null,
  phase: "publishing",
  phaseLabel: "界面已生成",
  progress: 1,
  attempt: 1,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: timestamp,
  startedAt: timestamp,
  finishedAt: timestamp,
};
let captureCompletedBaseline = true;

let board = {
  id: "board-1",
  projectId: project.id,
  revision: 1,
  viewport: { x: 300, y: 90, zoom: 0.63 },
  nodes: [{
    id: "node-1",
    kind: "artifact",
    parentNodeId: null,
    order: 0,
    position: { x: 120, y: 120 },
    size: { width: 360, height: 520 },
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "artifact",
      title: "Reference Screen",
      artifactKind: "prototype",
      screenId: "screen-home",
    },
  }],
  edges: [],
};

const artifact = {
  id: "artifact-1",
  projectId: project.id,
  kind: "prototype",
  title: "Reference Screen",
  revision: 1,
  currentVersion: {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
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
};

let projectMembers = [
  {
    projectId: project.id,
    principalId: "principal-1",
    role: "owner",
    displayName: "Board Reviewer",
    email: "board@example.test",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];
const workspaceMembers = [
  {
    principalId: "principal-1",
    role: "owner",
    displayName: "Board Reviewer",
    email: "board@example.test",
  },
  {
    principalId: "principal-2",
    role: "member",
    displayName: "采购编辑",
    email: "editor@example.test",
  },
];

const browser = await chromium.launch({ headless: true });
await mkdir("output/playwright", { recursive: true });
const context = await browser.newContext({ viewport: { width: 1501, height: 855 } });
await context.addCookies([{
  name: "workbench.session_token",
  value: "board-tools-session",
  url: origin,
}]);

await context.route(`${previewOrigin}/preview/**`, async (route) => {
  const capabilityId = new URL(route.request().url()).pathname.slice("/preview/".length);
  const bridged = injectWorkbenchPreviewBridge(previewHtml, origin, capabilityId);
  await route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy": previewContentSecurityPolicy(bridged.html, origin),
    },
    body: bridged.html,
  });
});

await context.route("**/api/auth/**", async (route) => {
  await json(route, {
    session: {
      id: "session-1",
      token: "board-tools-session",
      userId: "principal-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp,
      ipAddress: null,
      userAgent: "Playwright",
    },
    user: {
      id: "principal-1",
      name: "Board Reviewer",
      email: "board@example.test",
      emailVerified: true,
      image: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
});

await context.route("**/__workbench-e2e-upload/**", async (route) => {
  const request = route.request();
  assert(request.method() === "PUT", "The signed upload fixture only accepts PUT requests");
  assert(
    new URL(request.url()).pathname === "/__workbench-e2e-upload/upload-session-1/part-1",
    `Unexpected signed upload URL: ${request.url()}`,
  );
  uploadedPartPuts += 1;
  await route.fulfill({
    status: 200,
    headers: { etag: '"uploaded-part-1"' },
    body: "",
  });
});

await context.route("**/api/v1/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  if (method === "GET" && path === "/api/v1/identity/me") {
    return json(route, {
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "board-reviewer",
      email: "board@example.test",
      displayName: "Board Reviewer",
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
    return json(route, { items: [{ ...project, role: "owner", relationship: "owned" }], nextCursor: null });
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
      access: { role: "owner" },
      threads: [thread],
      selectedThreadId: thread.id,
      entries: [],
      board,
      artifacts: [artifact],
      latestRun: captureCompletedBaseline ? completedRun : null,
    }, { etag: `"${board.revision}"` });
  }
  if (method === "GET" && path === `/api/v1/runs/${completedRun.id}/approvals`) {
    return json(route, { items: [] });
  }
  if (method === "GET" && path === "/api/v1/threads/thread-1/submission-intents/current") {
    return json(route, {
      item: activeSubmissionIntent?.status === "pending" ? activeSubmissionIntent : null,
    });
  }
  if (method === "POST" && path === "/api/v1/threads/thread-1/submission-intents") {
    const idempotencyKey = request.headers()["idempotency-key"];
    assert(/^submission:[A-Za-z0-9_-]{8,}$/u.test(idempotencyKey ?? ""), "SubmissionIntent requires a caller-owned Idempotency-Key");
    const body = request.postDataJSON();
    assert(body.attachments?.length === 1 && body.attachments[0].kind === "upload", "SubmissionIntent must persist the selected upload slot before bytes move");
    assert(body.request?.prompt === "生成 Web 采购门户", "SubmissionIntent must persist the original prompt");
    assert(body.request?.targetSurface === "web", "SubmissionIntent must persist the selected target surface");
    createdSubmissionIntentRequests.push(body);
    activeSubmissionIntent = pendingSubmissionIntentFixture(body);
    return json(route, activeSubmissionIntent, {
      etag: '"1"',
      location: "/api/v1/submission-intents/intent-upload-1",
    }, 201);
  }
  if (method === "GET" && path === "/api/v1/artifacts/artifact-1") {
    return json(route, artifact, { etag: '"1"' });
  }
  if (method === "GET" && path === "/api/v1/artifacts/artifact-1/versions/version-1") {
    return json(route, {
      ...artifact.currentVersion,
      citations: [],
      knowledgeReleaseId: null,
      contentMode: "inline",
      content: prototypeDocumentFixture(),
    }, { etag: `"${checksum}"` });
  }
  if (path === "/api/v1/artifacts/artifact-1/versions/version-1/preference") {
    const screenId = new URL(request.url()).searchParams.get("screenId");
    assert(screenId === "screen-home", `Artifact preference must stay scoped to screen-home: ${screenId}`);
    if (method === "GET") {
      artifactPreferenceReads += 1;
      return json(route, artifactPreference, { etag: preferenceEtag(artifactPreference.revision) });
    }
    if (method === "PUT") {
      const expectedRevision = artifactPreference.revision;
      const ifMatch = request.headers()["if-match"];
      assert(
        ifMatch === preferenceEtag(expectedRevision),
        `Artifact preference update must use revision ${expectedRevision}`,
      );
      artifactPreferenceIfMatches.push(ifMatch);
      artifactPreferencePutsInFlight += 1;
      maxArtifactPreferencePutsInFlight = Math.max(
        maxArtifactPreferencePutsInFlight,
        artifactPreferencePutsInFlight,
      );
      try {
        if (delayNextArtifactPreferencePut) {
          delayNextArtifactPreferencePut = false;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert(
          artifactPreference.revision === expectedRevision,
          "Artifact preference PUTs must remain serialized while a prior CAS response is pending",
        );
        const body = request.postDataJSON();
        artifactPreference = {
          ...artifactPreference,
          favorite: body.favorite,
          reaction: body.reaction,
          revision: artifactPreference.revision + 1,
          createdAt: artifactPreference.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        artifactPreferenceUpdates.push(structuredClone(artifactPreference));
        await json(route, artifactPreference, { etag: preferenceEtag(artifactPreference.revision) });
        return;
      } finally {
        artifactPreferencePutsInFlight -= 1;
      }
    }
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/artifact-version-favorites") {
    const cursor = new URL(request.url()).searchParams.get("cursor");
    assert(cursor === null, "The board fixture favourites request must start from the opaque first page");
    return json(route, artifactPreference.favorite
      ? {
          items: [{
            artifactId: "artifact-1",
            artifactVersionId: "version-1",
            artifactKind: "prototype",
            artifactTitle: "Reference Screen",
            artifactVersion: 1,
            screenId: "screen-home",
            screenName: "Home",
            updatedAt: artifactPreference.updatedAt ?? timestamp,
          }],
          nextCursor: null,
        }
      : { items: [], nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/board") {
    return json(route, board, { etag: `"${board.revision}"` });
  }
  if (method === "PUT" && path === "/api/v1/projects/project-1/board") {
    const expected = `"${board.revision}"`;
    assert(request.headers()["if-match"] === expected, `Expected If-Match ${expected}`);
    const idempotencyKey = request.headers()["idempotency-key"];
    assert(/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey ?? ""), "Board save requires a valid Idempotency-Key");
    assert(!saveIdempotencyKeys.includes(idempotencyKey), "A new Board snapshot must use a fresh Idempotency-Key");
    saveIdempotencyKeys.push(idempotencyKey);
    const body = request.postDataJSON();
    board = {
      id: board.id,
      projectId: board.projectId,
      revision: board.revision + 1,
      ...body,
    };
    saves.push(structuredClone(board));
    return json(route, board, { etag: `"${board.revision}"` });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/releases") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/members") {
    return json(route, { items: projectMembers });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/invitations") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/workspaces/workspace-1/members") {
    const query = new URL(request.url()).searchParams.get("q")?.trim().toLowerCase();
    const items = query
      ? workspaceMembers.filter((member) => `${member.displayName} ${member.email}`.toLowerCase().includes(query))
      : workspaceMembers;
    return json(route, { items, nextCursor: null });
  }
  if (method === "PUT" && path === "/api/v1/projects/project-1/members/principal-2") {
    assert(/^"\d+"$/u.test(request.headers()["if-match"] ?? ""), "Member role update must use the Project ETag");
    const body = request.postDataJSON();
    assert(body.role === "editor", "The member fixture must be added as an editor");
    memberRoleUpdates.push(body);
    const candidate = workspaceMembers[1];
    projectMembers = [...projectMembers, { ...candidate, projectId: project.id, role: body.role }];
    return json(route, projectMembers.at(-1), { etag: '"2"' });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/shares") {
    return json(route, { items: [], activeCount: 0, nextCursor: null });
  }
  if (method === "GET" && path === "/api/v1/projects/project-1/exports") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "POST" && path === "/api/v1/projects/project-1/file-upload-sessions") {
    uploadSessionAttempts += 1;
    const idempotencyKey = request.headers()["idempotency-key"];
    assert(/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey ?? ""), "File upload requires an Idempotency-Key");
    uploadCreateIdempotencyKeys.push(idempotencyKey);
    if (uploadSessionAttempts === 1) {
      return json(route, { malformedFixture: true }, {}, 201);
    }
    assert(uploadSessionAttempts === 2, "Retry must replay the same upload create command exactly once");
    const body = request.postDataJSON();
    assert(
      body.submissionIntent?.submissionIntentId === "intent-upload-1"
        && body.submissionIntent?.attachmentPosition === 0
        && body.submissionIntent?.clientFingerprint === activeSubmissionIntent?.attachments[0]?.clientFingerprint,
      `Upload must bind the exact durable SubmissionIntent slot: ${JSON.stringify(body)}`,
    );
    assert(body.fileName === "retry-brief.txt", "Upload retry must preserve the selected File name");
    assert(body.declaredMediaType === "text/plain", "Upload retry must preserve the declared media type");
    assert(body.byteSize === 13, "Upload retry must preserve the selected File size");
    assert(/^[a-f0-9]{64}$/u.test(body.sha256), "Upload retry must preserve the client SHA-256 proof");
    return json(route, {
      file: uploadFileFixture("uploading"),
      upload: uploadSessionFixture("initiated"),
    }, { etag: '"1"' }, 201);
  }
  if (method === "GET" && path === "/api/v1/file-upload-sessions/upload-session-1/parts") {
    return json(route, { parts: [] });
  }
  if (method === "POST" && path === "/api/v1/file-upload-sessions/upload-session-1/parts/1") {
    assert(request.headers()["if-match"] === '"1"', "Part signing must use the upload revision ETag");
    assert(request.postDataJSON().contentLength === 13, "The signed part must match the selected File size");
    return json(route, {
      uploadSessionId: "upload-session-1",
      partNumber: 1,
      method: "PUT",
      url: `${origin}/__workbench-e2e-upload/upload-session-1/part-1`,
      headers: {},
      expiresAt: "2099-01-01T00:00:00.000Z",
    }, { etag: '"1"' });
  }
  if (method === "POST" && path === "/api/v1/file-upload-sessions/upload-session-1/complete") {
    uploadCompletionAttempts += 1;
    assert(uploadedPartPuts === 1, "Multipart completion must follow the signed byte upload");
    assert(request.headers()["if-match"] === '"1"', "Multipart completion must use the upload revision ETag");
    const body = request.postDataJSON();
    assert(
      body.parts?.length === 1
        && body.parts[0].partNumber === 1
        && body.parts[0].etag === '"uploaded-part-1"',
      `Multipart completion must bind the uploaded ETag: ${JSON.stringify(body)}`,
    );
    return json(route, {
      file: uploadFileFixture("verifying"),
      upload: uploadSessionFixture("completed"),
    }, {
      etag: '"2"',
      location: "/api/v1/files/file-upload-1",
    }, 202);
  }
  if (method === "GET" && path === "/api/v1/files/file-upload-1") {
    return json(route, uploadFileFixture("ready"), { etag: '"2"' });
  }
  if (method === "POST" && path === "/api/v1/submission-intents/intent-upload-1/submit") {
    assert(activeSubmissionIntent?.status === "pending", "Only the active pending SubmissionIntent may submit");
    assert(uploadCompletionAttempts === 1, "SubmissionIntent must not submit before its upload is complete");
    const finalRequest = {
      ...activeSubmissionIntent.request,
      sourceIds: ["source-file-upload-1"],
    };
    submittedIntentRunRequests.push(finalRequest);
    submittedSubmissionIntentIds.push(activeSubmissionIntent.id);
    activeSubmissionIntent = submittedSubmissionIntentFixture(activeSubmissionIntent);
    return json(route, {
      intent: activeSubmissionIntent,
      run: runFixture(finalRequest),
    }, {
      etag: '"2"',
      location: "/api/v1/runs/run-upload-1",
    }, 202);
  }
  if (method === "GET" && path === "/api/v1/runs/run-upload-1/approvals") {
    return json(route, { items: [] });
  }
  if (method === "GET" && path === "/api/v1/exports/capabilities") {
    return json(route, {
      html: { available: false, reasonCode: "EXPORT_HTML_UNAVAILABLE" },
      react: { available: false, reasonCode: "EXPORT_REACT_UNAVAILABLE" },
      figma: { available: false, reasonCode: "EXPORT_FIGMA_UNAVAILABLE" },
      mcp: { available: false, reasonCode: "EXPORT_MCP_UNAVAILABLE" },
    });
  }
  if (method === "POST" && path === "/api/v1/projects/project-1/previews") {
    const body = request.postDataJSON();
    assert(body.boardId === board.id, "Project Preview must pin the current Board identity");
    assert(body.boardRevision === board.revision, "Project Preview must pin the current Board revision");
    assert(body.selection?.kind === "artifact", "Screen Preview must use an Artifact selection");
    previewSelections.push(structuredClone(body.selection));
    const id = `preview-${++projectPreviewCount}`;
    const preview = projectPreviewFixture(id, body.selection);
    projectPreviews.set(id, preview);
    return json(route, preview, { location: `/api/v1/previews/${id}` }, 202);
  }
  const projectPreviewMatch = path.match(/^\/api\/v1\/previews\/(preview-\d+)$/u);
  if (method === "GET" && projectPreviewMatch) {
    return json(route, projectPreviews.get(projectPreviewMatch[1]));
  }
  const previewTokenMatch = path.match(/^\/api\/v1\/previews\/(preview-\d+)\/token$/u);
  if (method === "POST" && previewTokenMatch) {
    previewTokenCount += 1;
    return json(route, {
      url: `${previewOrigin}/preview/${previewTokenMatch[1]}-generation-${previewTokenCount}.html`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }

  unknownRequests.push(`${method} ${path}`);
  return json(route, {
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
const composer = page.locator("[data-project-composer]");

await page.goto(`${origin}/projects/project-1`, { waitUntil: "networkidle" });
assert(await page.title() === "产品工作台", "browser title must use 产品工作台");
await page.locator("[data-workbench-project]").waitFor();

const prototypeNode = page.locator('.react-flow__node[data-id="node-1"]');
await prototypeNode.waitFor();
await page.waitForTimeout(800);
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: projectBaselineScreenshot,
});
captureCompletedBaseline = false;
await page.reload({ waitUntil: "networkidle" });
await page.locator("[data-workbench-project]").waitFor();
await prototypeNode.click({ position: { x: 180, y: 220 } });
const screenToolbar = page.locator("[data-screen-context-toolbar]");
await screenToolbar.waitFor();
const screenToolbarSurface = screenToolbar.locator("[data-screen-context-toolbar-surface]");
await waitForAsyncValue(
  () => screenToolbar.getByRole("button", { name: "Generate prototype", exact: true })
    .isEnabled({ timeout: 250 }).catch(() => false),
  "single-screen context toolbar",
);
const singleToolbarActionButtons = screenToolbarSurface.locator(":scope > div:first-child > button");
const singleToolbarButtonLabels = await singleToolbarActionButtons.evaluateAll((buttons) => (
  buttons.map((button) => button.textContent?.trim()).filter(Boolean)
));
assert(
  JSON.stringify(singleToolbarButtonLabels) === JSON.stringify(["Generate", "Modify", "Generate prototype", "More"]),
  `Single screen toolbar must expose Generate/Modify/Generate prototype/More: ${JSON.stringify(singleToolbarButtonLabels)}`,
);
await screenToolbar.getByText("Reference Screen", { exact: true }).waitFor();
await screenToolbar.getByText("390 x 844", { exact: true }).waitFor();
await assertCanvasPanelLayout(screenToolbarSurface, "Desktop screen context toolbar");
await screenToolbar.getByRole("button", { name: "More" }).click();
const singleMoreMenu = screenToolbar.getByRole("menu");
await singleMoreMenu.waitFor();
for (const label of ["Rename", "Duplicate", "Favourite", "Like", "Dislike", "Version history", "Export", "Delete"]) {
  await contextMenuItem(singleMoreMenu, label).waitFor();
}
await assertCanvasPanelLayout(singleMoreMenu, "Desktop screen context More menu");
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: desktopScreenContextToolbarScreenshot,
});
await screenToolbar.getByRole("button", { name: "More" }).click();
await singleMoreMenu.waitFor({ state: "detached" });

const toolbarPrimaryButton = screenToolbar.getByRole("button", { name: "Generate", exact: true });
const zoomTrigger = page.locator(".workbench-zoom-trigger");
const zoomMenu = page.locator(".workbench-zoom-menu");
if ((await zoomTrigger.textContent())?.trim() !== "63%") {
  await zoomTrigger.click();
  await zoomMenu.waitFor();
  await zoomMenu.getByRole("menuitem", { name: "63%", exact: true }).click({ force: true });
  await zoomMenu.waitFor({ state: "detached" });
  await waitForAsyncValue(
    () => zoomTrigger.textContent().then((value) => value?.trim() === "63%"),
    "normalized 63% zoom label",
  );
}
assert((await zoomTrigger.textContent())?.trim() === "63%", "The zoom gate must start from 63%");
const toolbarBoundsAt63 = await waitForStableElementBounds(screenToolbarSurface, "Desktop screen context toolbar at 63%");
const nodeBoundsAt63 = await waitForStableElementBounds(prototypeNode, "Selected screen at 63%");
const primaryButtonBoundsAt63 = await waitForStableElementBounds(toolbarPrimaryButton, "Generate button at 63%");
const toolbarCenterAt63 = toolbarBoundsAt63.x + toolbarBoundsAt63.width / 2;
const nodeCenterAt63 = nodeBoundsAt63.x + nodeBoundsAt63.width / 2;
assert(
  Math.abs(toolbarCenterAt63 - nodeCenterAt63) <= 2,
  `The screen toolbar must stay horizontally centered over its node at 63%: ${JSON.stringify({
    toolbarBoundsAt63,
    nodeBoundsAt63,
  })}`,
);

await zoomTrigger.click();
await zoomMenu.waitFor();
await zoomMenu.getByRole("menuitem", { name: "93%", exact: true }).click({ force: true });
await zoomMenu.waitFor({ state: "detached" });
await waitForAsyncValue(
  () => zoomTrigger.textContent().then((value) => value?.trim() === "93%"),
  "93% zoom label",
);

const toolbarBoundsAt93 = await waitForStableElementBounds(screenToolbarSurface, "Desktop screen context toolbar at 93%");
const nodeBoundsAt93 = await waitForStableElementBounds(prototypeNode, "Selected screen at 93%");
const primaryButtonBoundsAt93 = await waitForStableElementBounds(toolbarPrimaryButton, "Generate button at 93%");
const toolbarCenterAt93 = toolbarBoundsAt93.x + toolbarBoundsAt93.width / 2;
const nodeCenterAt93 = nodeBoundsAt93.x + nodeBoundsAt93.width / 2;
assert(
  Math.abs(toolbarCenterAt93 - nodeCenterAt93) <= 2,
  `Canvas zoom must preserve the toolbar/node horizontal anchor: ${JSON.stringify({
    toolbarBoundsAt63,
    nodeBoundsAt63,
    toolbarBoundsAt93,
    nodeBoundsAt93,
  })}`,
);
assert(
  toolbarBoundsAt93.y + toolbarBoundsAt93.height <= nodeBoundsAt93.y + 1,
  `The screen toolbar must remain above its selected node at 93%: ${JSON.stringify({
    toolbarBoundsAt93,
    nodeBoundsAt93,
  })}`,
);
assert(
  Math.abs(primaryButtonBoundsAt93.width - primaryButtonBoundsAt63.width) <= 0.5
    && Math.abs(primaryButtonBoundsAt93.height - primaryButtonBoundsAt63.height) <= 0.5,
  `Canvas zoom must not scale toolbar controls: ${JSON.stringify({
    primaryButtonBoundsAt63,
    primaryButtonBoundsAt93,
  })}`,
);

await zoomTrigger.click();
await zoomMenu.waitFor();
await zoomMenu.getByRole("menuitem", { name: "63%", exact: true }).click({ force: true });
await zoomMenu.waitFor({ state: "detached" });
await waitForAsyncValue(
  () => zoomTrigger.textContent().then((value) => value?.trim() === "63%"),
  "restored 63% zoom label",
);
await waitForStableElementBounds(screenToolbarSurface, "Desktop screen context toolbar restored to 63%");
await page.getByRole("button", { name: "Select", exact: true }).click();
assert(
  await page.getByRole("button", { name: "Select", exact: true }).getAttribute("aria-pressed") === "true",
  "Select must be restored after the zoom gate switches the canvas to Pan",
);
await waitForSelectedNodeIds(["node-1"], "selection preservation across the zoom gate");

await screenToolbar.getByRole("button", { name: "More" }).click();
await singleMoreMenu.waitFor();
await contextMenuItem(singleMoreMenu, "Favourite").click();
await singleMoreMenu.waitFor({ state: "detached" });
await waitForValue(() => artifactPreferenceUpdates.length === 1, "favorite preference update");
await screenToolbar.getByRole("button", { name: "More" }).click();
const preferenceMoreMenu = screenToolbar.getByRole("menu");
await preferenceMoreMenu.waitFor();
await contextMenuItem(preferenceMoreMenu, "Like").click();
await preferenceMoreMenu.waitFor({ state: "detached" });
await waitForValue(() => artifactPreferenceUpdates.length === 2, "like preference update");
assert(artifactPreference.favorite === true, "The selected screen must persist its favorite state");
assert(artifactPreference.reaction === "like", "The selected screen must persist its like reaction");

await page.reload({ waitUntil: "networkidle" });
await page.locator("[data-workbench-project]").waitFor();
await screenToolbar.waitFor();
await screenToolbar.getByRole("button", { name: "More" }).click();
const restoredPreferenceMenu = screenToolbar.getByRole("menu");
await restoredPreferenceMenu.waitFor();
assert(
  await contextMenuItem(restoredPreferenceMenu, "Unfavourite").isEnabled(),
  "A full refresh must restore the selected screen favorite state",
);
assert(
  await contextMenuItem(restoredPreferenceMenu, "Like").getAttribute("aria-checked") === "true",
  "A full refresh must restore the selected screen reaction",
);
await screenToolbar.getByRole("button", { name: "More" }).click();
await restoredPreferenceMenu.waitFor({ state: "detached" });
await page.waitForTimeout(800);
saves.length = 0;
saveIdempotencyKeys.length = 0;

const rail = page.locator("[data-right-tool-rail]");
const primaryToolLabels = await rail.locator(":scope > button[aria-label]").evaluateAll((buttons) => (
  buttons.map((button) => button.getAttribute("aria-label"))
));
assert(
  JSON.stringify(primaryToolLabels) === JSON.stringify([
    "Select",
    "Marquee",
    "Direct edit",
    "Pan",
    "Media",
    "Design system",
    "Favourites",
  ]),
  `The primary rail must use the canonical seven commands: ${JSON.stringify(primaryToolLabels)}`,
);

artifactPreferenceIfMatches.length = 0;
maxArtifactPreferencePutsInFlight = 0;
delayNextArtifactPreferencePut = true;
await page.keyboard.press("Shift+F");
await waitForValue(() => artifactPreferencePutsInFlight === 1, "first rapid Shift+F preference PUT");
await page.keyboard.press("Shift+F");
await waitForValue(
  () => artifactPreferenceUpdates.length === 4 && artifactPreferencePutsInFlight === 0,
  "rapid Shift+F favorite toggle pair",
);
assert(artifactPreference.favorite === true, "Two rapid Shift+F commands must restore the selected screen favorite");
assert(
  maxArtifactPreferencePutsInFlight === 1,
  `Rapid Shift+F preference PUTs must be serialized; observed ${maxArtifactPreferencePutsInFlight} in flight`,
);
assert(
  JSON.stringify(artifactPreferenceIfMatches) === JSON.stringify([preferenceEtag(2), preferenceEtag(3)]),
  `Rapid Shift+F must advance If-Match monotonically: ${JSON.stringify(artifactPreferenceIfMatches)}`,
);

const submissionIntentsBeforeGeneratePrototype = createdSubmissionIntentRequests.length;
const runsBeforeGeneratePrototype = submittedIntentRunRequests.length;
await screenToolbar.getByRole("button", { name: "Generate prototype" }).click();
const generatePrototypeContext = composer.locator('[data-composer-context="generate-prototype"]');
await generatePrototypeContext.waitFor();
assert(
  await generatePrototypeContext.getAttribute("aria-label") === "移除选择上下文 生成原型：Reference Screen",
  `Generate prototype must establish the selected screen Composer context: ${await generatePrototypeContext.getAttribute("aria-label")}`,
);
assert(
  createdSubmissionIntentRequests.length === submissionIntentsBeforeGeneratePrototype
    && submittedIntentRunRequests.length === runsBeforeGeneratePrototype,
  "Generate prototype must not submit a Run before the Composer is submitted",
);
await generatePrototypeContext.click();
await generatePrototypeContext.waitFor({ state: "detached" });

await page.getByRole("button", { name: "Favourites" }).click();
const favouritesPanel = page.locator("[data-workbench-canvas-favourites-panel]");
await favouritesPanel.waitFor();
await favouritesPanel.getByText("Home").waitFor();
await assertCanvasPanelLayout(favouritesPanel, "Desktop Favourites panel");
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: desktopFavouritesPanelScreenshot,
});
await page.getByRole("button", { name: "关闭 Favourites" }).click();
await favouritesPanel.waitFor({ state: "detached" });

await page.getByRole("button", { name: "Design system" }).click();
const designSystemPanel = page.locator("[data-workbench-canvas-design-system-panel]");
await waitForAsyncValue(
  () => designSystemPanel.getAttribute("aria-busy").then((value) => value === "false"),
  "Desktop Design system readiness",
);
assert(await designSystemPanel.getByRole("alert").count() === 0, "Desktop Design system must open without an error state");
await assertCanvasPanelLayout(designSystemPanel, "Desktop Design system panel");
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: desktopDesignSystemPanelScreenshot,
});
await page.getByRole("button", { name: "关闭 Design system" }).click();
await designSystemPanel.waitFor({ state: "detached" });

const secondaryPrototypeNodeId = "node-secondary-screen";
board = {
  ...board,
  revision: board.revision + 1,
  nodes: [...board.nodes, {
    ...structuredClone(board.nodes[0]),
    id: secondaryPrototypeNodeId,
    order: 1,
    position: { x: 540, y: 120 },
    data: {
      ...structuredClone(board.nodes[0].data),
      title: "Checkout Screen",
      screenId: "screen-checkout",
    },
  }],
};
await page.reload({ waitUntil: "networkidle" });
await page.locator("[data-workbench-project]").waitFor();
await selectNodeByKeyboard(prototypeNode, "Primary screen before multi-screen Generate prototype");
const secondaryPrototypeNode = page.locator(
  `.react-flow__node[data-id="${secondaryPrototypeNodeId}"]`,
);
await shiftSelectNodeByKeyboard(
  secondaryPrototypeNode,
  "Secondary screen before multi-screen Generate prototype",
);
await waitForSelectedNodeIds(
  ["node-1", secondaryPrototypeNodeId],
  "multi-screen Generate prototype selection",
);
await screenToolbar.getByText("2 selected", { exact: true }).waitFor();
const multiGeneratePrototypeButton = screenToolbar.getByRole(
  "button",
  { name: "Generate prototype", exact: true },
);
await waitForAsyncValue(
  () => multiGeneratePrototypeButton.isEnabled({ timeout: 250 }).catch(() => false),
  "multi-screen Generate prototype availability",
);
const submissionIntentsBeforeMultiGeneratePrototype = createdSubmissionIntentRequests.length;
const runsBeforeMultiGeneratePrototype = submittedIntentRunRequests.length;
await multiGeneratePrototypeButton.click();
const multiGeneratePrototypeContext = composer.locator('[data-composer-context="generate-prototype"]');
await multiGeneratePrototypeContext.waitFor();
assert(
  await multiGeneratePrototypeContext.getAttribute("aria-label")
    === "移除选择上下文 生成原型：已选择 2 个界面",
  `Multi-screen Generate prototype must establish the exact Composer context: ${await multiGeneratePrototypeContext.getAttribute("aria-label")}`,
);
assert(
  await composer.locator("input.workbench-composer-field").inputValue()
    === "为所选 2 个界面生成可交互原型",
  "Multi-screen Generate prototype must prefill the confirmation prompt",
);
assert(
  createdSubmissionIntentRequests.length === submissionIntentsBeforeMultiGeneratePrototype
    && submittedIntentRunRequests.length === runsBeforeMultiGeneratePrototype,
  "Multi-screen Generate prototype must not submit before Composer confirmation",
);
await multiGeneratePrototypeContext.click();
await multiGeneratePrototypeContext.waitFor({ state: "detached" });

const unselectedPreviewNodeId = "node-unselected-preview";
runnablePreviewEnabled = true;
board = {
  ...board,
  revision: board.revision + 1,
  nodes: [...board.nodes, {
    ...structuredClone(board.nodes[0]),
    id: unselectedPreviewNodeId,
    order: 2,
    position: { x: 960, y: 120 },
    data: {
      ...structuredClone(board.nodes[0].data),
      title: "Settings Screen",
      screenId: "screen-settings",
    },
  }],
};
await page.reload({ waitUntil: "networkidle" });
await page.locator("[data-workbench-project]").waitFor();
await selectNodeByKeyboard(prototypeNode, "Primary runnable Preview screen");
await shiftSelectNodeByKeyboard(secondaryPrototypeNode, "Secondary runnable Preview screen");
await waitForSelectedNodeIds(
  ["node-1", secondaryPrototypeNodeId],
  "frozen runnable multi-screen Preview selection",
);
await screenToolbar.getByText("2 selected", { exact: true }).waitFor();
const multiPreviewButton = screenToolbar.getByRole("button", { name: "Preview", exact: true });
await waitForAsyncValue(
  () => multiPreviewButton.isEnabled({ timeout: 250 }).catch(() => false),
  "runnable multi-screen Preview availability",
);
const previewsBeforeDirectOpen = previewSelections.length;
await multiPreviewButton.click();
const previewOverlay = page.locator("[data-project-preview]");
await previewOverlay.waitFor();
await previewOverlay.getByRole("button", { name: "Reference Screen", exact: true }).waitFor();
await previewOverlay.getByRole("button", { name: "Checkout Screen", exact: true }).waitFor();
assert(
  await previewOverlay.getByRole("button", { name: "Settings Screen", exact: true }).count() === 0,
  "Multi-screen Preview must exclude runnable screens outside the frozen selection",
);
await waitForValue(
  () => previewSelections.length === previewsBeforeDirectOpen + 1,
  "first selected-screen Preview creation",
);
assert(
  previewSelections.at(-1)?.screenId === "screen-home",
  `Multi-screen Preview must preserve its first selected screen: ${JSON.stringify(previewSelections)}`,
);
await previewOverlay.getByRole("button", { name: "Checkout Screen", exact: true }).click();
await waitForValue(
  () => previewSelections.length === previewsBeforeDirectOpen + 2,
  "second selected-screen Preview creation",
);
assert(
  previewSelections.at(-1)?.screenId === "screen-checkout",
  `Multi-screen Preview must preserve selected-screen order: ${JSON.stringify(previewSelections)}`,
);
assert(
  previewSelections.slice(previewsBeforeDirectOpen).every((selection) => (
    selection.artifactId === "artifact-1"
    && selection.artifactVersionId === "version-1"
    && selection.screenId !== "screen-settings"
  )),
  "Multi-screen Preview must remain scoped to the frozen ArtifactVersion screen references",
);
await previewOverlay.getByRole("button", { name: "退出预览" }).click();
await previewOverlay.waitFor({ state: "detached" });

board = {
  ...board,
  revision: board.revision + 1,
  nodes: board.nodes.filter((node) => (
    node.id !== secondaryPrototypeNodeId && node.id !== unselectedPreviewNodeId
  )),
};
runnablePreviewEnabled = false;
await page.reload({ waitUntil: "networkidle" });
await page.locator("[data-workbench-project]").waitFor();
await selectNodeByKeyboard(prototypeNode, "Stage 2 restored node-1");
await waitForSelectedNodeIds(["node-1"], "Stage 2 restored node-1 selection");

saves.length = 0;
saveIdempotencyKeys.length = 0;
assert(
  JSON.stringify(board.nodes.map((node) => node.id)) === JSON.stringify(["node-1"]),
  `Stage 2 atomic selection flow must start from only node-1: ${JSON.stringify(board.nodes.map((node) => node.id))}`,
);
const stage2SelectButton = page.getByRole("button", { name: "Select", exact: true });
await stage2SelectButton.click();
await waitForAsyncValue(
  () => stage2SelectButton.getAttribute("aria-pressed").then((value) => value === "true"),
  "Stage 2 Select tool activation",
);

await screenToolbar.getByRole("button", { name: "More" }).click();
const stage2SingleMoreMenu = screenToolbar.getByRole("menu");
await stage2SingleMoreMenu.waitFor();
await stage2SingleMoreMenu.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
await stage2SingleMoreMenu.waitFor({ state: "detached" });
await waitForStage2Save("single-duplicate", (value) => value.nodes.length === 2);
const singleDuplicateId = board.nodes.find((node) => node.id !== "node-1")?.id;
assert(singleDuplicateId, "Single Duplicate must create one persisted copy");
await waitForSelectedNodeIds([singleDuplicateId], "single Duplicate selection");

await shiftSelectNodeByKeyboard(prototypeNode, "Original screen after Duplicate");
const sourcePairIds = [singleDuplicateId, "node-1"].sort();
await waitForSelectedNodeIds(sourcePairIds, "two-screen source selection");
await screenToolbar.getByText("2 selected", { exact: true }).waitFor();

const nodeIdsBeforeMultiDuplicate = new Set(board.nodes.map((node) => node.id));
await screenToolbar.getByRole("button", { name: "Duplicate" }).click();
await waitForStage2Save("multi-duplicate", (value) => value.nodes.length === 4);
const multiDuplicateIds = board.nodes
  .filter((node) => !nodeIdsBeforeMultiDuplicate.has(node.id))
  .map((node) => node.id)
  .sort();
assert(
  multiDuplicateIds.length === 2,
  `Multi Duplicate must create exactly one copy for each selected source: ${JSON.stringify(multiDuplicateIds)}`,
);
await waitForSelectedNodeIds(multiDuplicateIds, "multi Duplicate copy selection");

const singleDuplicateNode = page.locator(`.react-flow__node[data-id="${singleDuplicateId}"]`);
await shiftSelectNodeByKeyboard(singleDuplicateNode, "First copy after multi Duplicate");
const stage2SelectedCopyIds = [singleDuplicateId, ...multiDuplicateIds].sort();
await waitForSelectedNodeIds(stage2SelectedCopyIds, "three-copy selection");
await screenToolbar.getByText("3 selected", { exact: true }).waitFor();

const alignButton = screenToolbar.getByRole("button", { name: "Align" });
const distributeButton = screenToolbar.getByRole("button", { name: "Distribute" });
const multiExportButton = screenToolbar.getByRole("button", { name: "Export" });
const generateVariantsButton = screenToolbar.getByRole("button", { name: "Generate variants" });
assert(await alignButton.isEnabled(), "Three persisted copies must enable Align");
assert(await distributeButton.isEnabled(), "Three persisted copies must enable Distribute");
assert(await multiExportButton.isEnabled(), "Three persisted copies must enable Export");
assert(
  await generateVariantsButton.isDisabled(),
  "Generate variants must remain disabled when every selected node repeats the same screen target",
);

const positionsBeforeDistribute = boardNodePositionProjectionForIds(board, stage2SelectedCopyIds);
await distributeButton.click();
const distributeMenu = screenToolbar.getByRole("menu");
await distributeMenu.waitFor();
await distributeMenu.getByRole("menuitem", { name: "Horizontal spacing", exact: true }).click();
await distributeMenu.waitFor({ state: "detached" });
await waitForStage2Save("distribute-horizontal", (value) => (
  JSON.stringify(boardNodePositionProjectionForIds(value, stage2SelectedCopyIds))
    !== JSON.stringify(positionsBeforeDistribute)
));
await waitForSelectedNodeIds(stage2SelectedCopyIds, "Distribute Horizontal selection preservation");

const positionsBeforeAlign = boardNodePositionProjectionForIds(board, stage2SelectedCopyIds);
await alignButton.click();
const alignMenu = screenToolbar.getByRole("menu");
await alignMenu.waitFor();
await alignMenu.getByRole("menuitem", { name: "Left", exact: true }).click();
await alignMenu.waitFor({ state: "detached" });
await waitForStage2Save("align-left", (value) => (
  JSON.stringify(boardNodePositionProjectionForIds(value, stage2SelectedCopyIds))
    !== JSON.stringify(positionsBeforeAlign)
));
await waitForSelectedNodeIds(stage2SelectedCopyIds, "Align Left selection preservation");

const savesBeforeStage2Export = saves.length;
await multiExportButton.click();
const exportPanel = page.locator('[data-workbench-export-panel][data-export-state="selected"]');
await exportPanel.waitFor();
await exportPanel.getByText("当前选择", { exact: true }).waitFor();
await exportPanel.getByText("已固定 3 个画布节点", { exact: true }).waitFor();
assert(saves.length === savesBeforeStage2Export, "Opening Export must not enqueue a Board save");
await exportPanel.getByRole("button", { name: "Close" }).click();
await exportPanel.waitFor({ state: "detached" });

await screenToolbar.getByRole("button", { name: "Delete" }).click();
const deleteDialog = page.getByRole("alertdialog");
await deleteDialog.waitFor();
await deleteDialog.getByText("将删除 3 个画布节点及其全部连接。此操作可通过撤销恢复。", { exact: true }).waitFor();
await deleteDialog.getByRole("button", { name: "确认删除" }).click();
await waitForStage2Save("delete-three-copies", (value) => (
  value.nodes.length === 1 && value.nodes[0]?.id === "node-1"
));
await deleteDialog.waitFor({ state: "detached" });
await waitForSelectedNodeIds([], "selection clearing after Stage 2 Delete");
assert(
  JSON.stringify(board.nodes.map((node) => node.id)) === JSON.stringify(["node-1"]),
  `Stage 2 must delete only the three copies: ${JSON.stringify(board.nodes.map((node) => node.id))}`,
);
await selectNodeByKeyboard(prototypeNode, "Stage 2 final node-1");
await waitForSelectedNodeIds(["node-1"], "Stage 2 final node-1 selection");
const expectedStage2SaveLabels = [
  "single-duplicate",
  "multi-duplicate",
  "align-left",
  "distribute-horizontal",
  "delete-three-copies",
];
assert(
  Object.keys(stage2SaveCounts).length === expectedStage2SaveLabels.length
    && expectedStage2SaveLabels.every((label) => stage2SaveCounts[label] === 1),
  `Every Stage 2 Board command must save exactly once: ${JSON.stringify(stage2SaveCounts)}`,
);
saves.length = 0;
saveIdempotencyKeys.length = 0;

const directEditButton = page.getByRole("button", { name: "Direct edit" });
await waitForAsyncValue(
  () => directEditButton.isEnabled({ timeout: 250 }).catch(() => false),
  "Direct edit availability",
);
await directEditButton.click();
await page.locator('[data-prototype-editing="true"]').waitFor();
await page.keyboard.press("Escape");
await selectNodeByKeyboard(prototypeNode, "node-1 after Direct edit");

const savesBeforeMarquee = saves.length;
const flowPane = page.locator(".react-flow__pane");
const flowBounds = await flowPane.boundingBox();
assert(flowBounds, "React Flow pane must be measurable for Marquee smoke coverage");
await page.mouse.click(flowBounds.x + flowBounds.width - 180, flowBounds.y + 90);
await waitForSelectedNodeIds([], "selection reset before Marquee");
const prototypeBounds = await prototypeNode.boundingBox();
assert(prototypeBounds, "Prototype node must be measurable for Marquee smoke coverage");
await page.getByRole("button", { name: "Marquee" }).click();
await page.mouse.move(
  Math.min(flowBounds.x + flowBounds.width - 4, prototypeBounds.x + prototypeBounds.width + 16),
  Math.min(flowBounds.y + flowBounds.height - 4, prototypeBounds.y + prototypeBounds.height + 16),
);
await page.mouse.down();
await page.mouse.move(
  Math.max(flowBounds.x + 4, prototypeBounds.x - 16),
  Math.max(flowBounds.y + 4, prototypeBounds.y - 16),
  { steps: 8 },
);
await page.mouse.up();
await waitForSelectedNodeIds(["node-1"], "Marquee selection");
assert(saves.length === savesBeforeMarquee, "Marquee must not create or persist a Frame");
assert(!board.nodes.some((node) => node.kind === "frame"), "Marquee must not create a Frame node");

await page.getByRole("button", { name: "More tools" }).click();
await page.getByRole("menuitem", { name: "Frame / Create", exact: true }).click();
const frameLayer = page.locator('[data-board-tool-gesture-layer="frame-create"]');
await frameLayer.waitFor();
await frameLayer.hover({ position: { x: 710, y: 220 } });
await page.mouse.down();
await page.mouse.move(1_100, 620, { steps: 8 });
await page.mouse.up();
await waitForBoard((value) => value.nodes.some((node) => node.kind === "frame"), "Frame save");

const frameNode = board.nodes.find((node) => node.kind === "frame");
assert(frameNode, "Frame gesture must persist a Frame node");
assert(frameNode.data.protocol === "workbench.board-node.v1", "Frame must use the Board v1 protocol");
assert(frameNode.data.nodeType === "frame", "Frame discriminator must be persisted");

await page.getByRole("button", { name: "Select" }).click();
assert(
  await page.getByRole("button", { name: "Select" }).getAttribute("aria-pressed") === "true",
  "Select must be active before multi-select",
);
const frameLocator = page.locator(`.react-flow__node[data-id="${frameNode.id}"]`);
await selectNodeByKeyboard(frameLocator, "Frame before Shift multi-select");
await waitForAsyncValue(
  () => frameLocator.getAttribute("class").then((value) => value?.includes("selected") ?? false),
  "Frame selection before Shift multi-select",
);
await shiftSelectNodeByKeyboard(prototypeNode, "node-1 after Frame selection");
const expectedMultiSelection = [frameNode.id, "node-1"].sort();
await waitForSelectedNodeIds(expectedMultiSelection, "Shift multi-select");
await page.getByRole("button", { name: "Pan" }).click();
const panFlowBounds = await flowPane.boundingBox();
assert(panFlowBounds, "React Flow pane must be measurable for Pan smoke coverage");
const flowViewport = page.locator(".react-flow__viewport");
const transformBeforePan = await flowViewport.evaluate((element) => getComputedStyle(element).transform);
const viewportBeforePan = structuredClone(board.viewport);
await page.mouse.move(
  panFlowBounds.x + panFlowBounds.width - 200,
  panFlowBounds.y + panFlowBounds.height - 120,
);
await page.mouse.down();
await page.mouse.move(
  panFlowBounds.x + panFlowBounds.width - 270,
  panFlowBounds.y + panFlowBounds.height - 160,
  { steps: 8 },
);
await page.mouse.up();
await waitForAsyncValue(
  () => flowViewport.evaluate((element) => getComputedStyle(element).transform)
    .then((transform) => transform !== transformBeforePan),
  "Pan viewport transform",
);
await waitForBoard(
  (value) => value.viewport.x !== viewportBeforePan.x || value.viewport.y !== viewportBeforePan.y,
  "Pan viewport save",
);
const transformAfterPan = await flowViewport.evaluate((element) => getComputedStyle(element).transform);
assert(
  transformAfterPan !== transformBeforePan,
  `Pan must change the React Flow transform: ${JSON.stringify({ transformBeforePan, transformAfterPan })}`,
);
await waitForSelectedNodeIds(expectedMultiSelection, "Pan selection preservation");
const frameBeforePanNodeDrag = board.nodes.find((node) => node.id === frameNode.id);
assert(frameBeforePanNodeDrag, "Persisted Frame must remain available before the Pan node-drag guard");
const framePositionBeforePanNodeDrag = structuredClone(frameBeforePanNodeDrag.position);
const nodePositionsBeforePanNodeDrag = boardNodePositionProjection(board);
const viewportBeforePanNodeDrag = structuredClone(board.viewport);
const savesBeforePanNodeDrag = saves.length;
const frameBoundsBeforePanNodeDrag = await frameLocator.boundingBox();
assert(frameBoundsBeforePanNodeDrag, "Frame must be measurable for the Pan node-drag guard");
await page.mouse.move(
  frameBoundsBeforePanNodeDrag.x + Math.min(80, frameBoundsBeforePanNodeDrag.width / 2),
  frameBoundsBeforePanNodeDrag.y + Math.min(80, frameBoundsBeforePanNodeDrag.height / 2),
);
await page.mouse.down();
await page.mouse.move(
  frameBoundsBeforePanNodeDrag.x + Math.min(80, frameBoundsBeforePanNodeDrag.width / 2) + 60,
  frameBoundsBeforePanNodeDrag.y + Math.min(80, frameBoundsBeforePanNodeDrag.height / 2) + 40,
  { steps: 6 },
);
await page.mouse.up();
await waitForBoard(
  (value) => value.viewport.x !== viewportBeforePanNodeDrag.x || value.viewport.y !== viewportBeforePanNodeDrag.y,
  "Pan node-origin viewport save",
);
const frameAfterPanNodeDrag = board.nodes.find((node) => node.id === frameNode.id);
assert(frameAfterPanNodeDrag, "Persisted Frame must remain available after the Pan node-drag guard");
assert(
  JSON.stringify(frameAfterPanNodeDrag.position) === JSON.stringify(framePositionBeforePanNodeDrag),
  `Pan must not move a Board node: ${JSON.stringify({
    before: framePositionBeforePanNodeDrag,
    after: frameAfterPanNodeDrag.position,
  })}`,
);
const panNodeDragSaves = saves.slice(savesBeforePanNodeDrag);
assert(
  panNodeDragSaves.length > 0
    && panNodeDragSaves.every((savedBoard) => (
      JSON.stringify(boardNodePositionProjection(savedBoard)) === JSON.stringify(nodePositionsBeforePanNodeDrag)
    )),
  `Dragging from a node in Pan may save only viewport changes: ${JSON.stringify(panNodeDragSaves.map((savedBoard) => ({
    revision: savedBoard.revision,
    viewport: savedBoard.viewport,
    nodes: boardNodePositionProjection(savedBoard),
  })))}`,
);
await waitForSelectedNodeIds(expectedMultiSelection, "Pan node-drag selection preservation");

await page.getByRole("button", { name: "More tools" }).click();
await page.getByRole("menuitem", { name: "Freehand", exact: true }).click();
const drawingLayer = page.locator('[data-board-tool-gesture-layer="freehand"]');
await drawingLayer.waitFor();
await drawingLayer.hover({ position: { x: 760, y: 300 } });
await page.mouse.down();
await page.mouse.move(840, 360, { steps: 5 });
await page.mouse.move(920, 330, { steps: 5 });
await page.mouse.move(980, 500, { steps: 5 });
await page.mouse.up();
await waitForBoard((value) => value.nodes.some((node) => node.kind === "drawing"), "Drawing save");

const drawingNode = board.nodes.find((node) => node.kind === "drawing");
assert(drawingNode, "Freehand gesture must persist a Drawing node");
assert(drawingNode.data.protocol === "workbench.board-node.v1", "Freehand must use the Board v1 protocol");
assert(drawingNode.data.stroke.algorithm === "perfect-freehand@1", "Drawing must pin the freehand algorithm family");
assert(drawingNode.data.stroke.intrinsicSize.width > 0, "Drawing must persist its intrinsic width");
assert(drawingNode.data.stroke.intrinsicSize.height > 0, "Drawing must persist its intrinsic height");
assert(drawingNode.data.stroke.simulatePressure === true, "Mouse drawing must use simulated pressure");
assert(drawingNode.data.stroke.points.length >= 8, "Drawing must persist sampled points");
assert(drawingNode.parentNodeId === frameNode.id, "Drawing inside a Frame must persist the Frame parent");

await page.getByTitle("Undo").click();
await waitForBoard((value) => !value.nodes.some((node) => node.kind === "drawing"), "Drawing undo save");
assert(!board.nodes.some((node) => node.kind === "drawing"), "Undo must remove the Drawing in one Board revision");

await page.getByTitle("Redo").click();
await waitForBoard((value) => value.nodes.some((node) => node.kind === "drawing"), "Drawing redo save");
assert(board.nodes.some((node) => node.kind === "drawing"), "Redo must restore the Drawing in one Board revision");

await page.reload({ waitUntil: "networkidle" });
await page.locator("[data-workbench-project]").waitFor();
await page.locator(`.react-flow__node[data-id="${frameNode.id}"]`).waitFor();
await page.locator(`.react-flow__node[data-id="${drawingNode.id}"] svg path`).waitFor();
await page.screenshot({
  path: "output/playwright/workbench-board-tools-desktop-1501x855.png",
  fullPage: true,
});

const composerField = composer.locator("input.workbench-composer-field");
await composer.getByRole("button", { name: "Web" }).click();
await composerField.fill("生成 Web 采购门户");
await composer.locator('input[type="file"]').setInputFiles({
  name: "retry-brief.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("retry fixture"),
});
await composer.getByText("retry-brief.txt").waitFor();
const composerSend = composer.locator("button.workbench-composer-send");
assert(await composerSend.isEnabled(), `Project Composer must be submittable: ${JSON.stringify({
  composerBusy: await composer.locator(".workbench-composer-shell").getAttribute("data-busy"),
  prompt: await composerField.inputValue(),
  selectedFileCount: await composer.locator('input[type="file"]').evaluate((input) => input.files?.length ?? 0),
  webSelected: await composer.getByRole("button", { name: "Web" }).getAttribute("aria-pressed"),
})}`);
await composerSend.click();
try {
  await waitForValue(() => uploadSessionAttempts === 1, "retryable upload failure");
} catch (error) {
  console.error(JSON.stringify({
    uploadSessionAttempts,
    createdSubmissionIntentRequests,
    submittedIntentRunRequests,
    unknownRequests,
    consoleErrors,
    composerBusy: await composer.locator(".workbench-composer-shell").getAttribute("data-busy"),
    composerDisabled: await composerSend.isDisabled(),
    toasts: await page.locator("[data-sonner-toast]").allTextContents(),
  }, null, 2));
  throw error;
}
const uploadList = page.locator("[data-workbench-upload-list]");
await uploadList.waitFor();
const retryUploadButton = uploadList.getByRole("button", { name: "重试上传 retry-brief.txt" });
await retryUploadButton.waitFor();
assert(
  await composerField.inputValue() === "生成 Web 采购门户",
  "A retryable upload failure must retain the Project Composer draft",
);
assert(
  await composer.getByText("retry-brief.txt").isVisible(),
  "A retryable upload failure must retain the selected attachment",
);
assert(submittedIntentRunRequests.length === 0, "A SubmissionIntent must not create its Run before every selected File is ready");

await retryUploadButton.click();
await waitForValue(() => submittedIntentRunRequests.length === 1, "resumed original SubmissionIntent submit");
await uploadList.waitFor({ state: "hidden" });
assert(uploadSessionAttempts === 2, "Retry must replay the upload session create exactly once");
assert(uploadCompletionAttempts === 1, "Retry must complete the multipart upload exactly once");
assert(uploadedPartPuts === 1, "Retry must upload the selected bytes exactly once");
assert(
  uploadCreateIdempotencyKeys.length === 2
    && uploadCreateIdempotencyKeys[0] === uploadCreateIdempotencyKeys[1],
  "Retry must reuse the original upload create Idempotency-Key",
);
assert(
  submittedIntentRunRequests[0].targetSurface === "web",
  `Project Composer must submit the selected Web target: ${JSON.stringify(submittedIntentRunRequests[0])}`,
);
assert(
  submittedIntentRunRequests[0].prompt === "生成 Web 采购门户",
  "Project Composer must preserve the submitted prompt",
);
assert(
  submittedIntentRunRequests[0].sourceIds?.length === 1
    && submittedIntentRunRequests[0].sourceIds[0] === "source-file-upload-1",
  `The resumed submission must include the materialized Import Source: ${JSON.stringify(submittedIntentRunRequests[0])}`,
);
assert(createdSubmissionIntentRequests.length === 1, "The original command must create exactly one durable SubmissionIntent");
assert(submittedSubmissionIntentIds.length === 1, "The durable SubmissionIntent must submit exactly once");

await page.getByRole("button", { name: "项目菜单" }).click();
await page.getByRole("menuitem", { name: "成员与权限", exact: true }).click();
const membersDialog = page.locator("[data-project-members-dialog]");
await membersDialog.waitFor();
assert(await membersDialog.getByText("Board Reviewer").count() >= 1, "Members dialog must show the current owner");
await membersDialog.getByRole("textbox", { name: "搜索工作区成员" }).fill("editor");
const addMemberButton = membersDialog.getByRole("button", { name: "添加" });
await addMemberButton.waitFor({ state: "visible" });
await addMemberButton.click();
await waitForValue(() => memberRoleUpdates.length === 1, "member role update");
assert(memberRoleUpdates[0].role === "editor", "Members dialog must add the searched member as editor");
await membersDialog.getByRole("button", { name: "完成" }).click();

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
for (const selector of ["[data-right-tool-rail]", "[data-project-composer]"]) {
  const bounds = await page.locator(selector).boundingBox();
  assert(bounds, `${selector} must remain visible on mobile`);
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, `${selector} must fit the mobile viewport`);
}
const toolbarOverflow = await composer.locator("[data-project-composer-toolbar]").evaluate(
  (element) => element.scrollWidth - element.clientWidth,
);
assert(toolbarOverflow <= 1, `Project Composer toolbar must not overflow on mobile: ${toolbarOverflow}px`);
await page.getByRole("button", { name: "Favourites" }).click();
await favouritesPanel.getByText("Home").waitFor();
await assertCanvasPanelLayout(favouritesPanel, "Mobile Favourites panel");
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: mobileFavouritesPanelScreenshot,
});
await favouritesPanel.getByText("Home", { exact: true }).click();
await favouritesPanel.waitFor({ state: "detached" });
await waitForSelectedNodeIds(["node-1"], "Mobile Favourites item selection");

await screenToolbar.waitFor();
await waitForAsyncValue(
  () => screenToolbar.getByRole("button", { name: "Generate prototype", exact: true })
    .isEnabled({ timeout: 250 }).catch(() => false),
  "mobile single-screen context toolbar",
);
const mobileToolbarButtonLabels = await singleToolbarActionButtons.evaluateAll((buttons) => (
  buttons.map((button) => button.textContent?.trim()).filter(Boolean)
));
assert(
  JSON.stringify(mobileToolbarButtonLabels) === JSON.stringify(["Generate", "Modify", "Generate prototype", "More"]),
  `Mobile screen toolbar must expose Generate/Modify/Generate prototype/More: ${JSON.stringify(mobileToolbarButtonLabels)}`,
);
await screenToolbar.getByText("Reference Screen", { exact: true }).waitFor();
await screenToolbar.getByText("390 x 844", { exact: true }).waitFor();
await assertCanvasPanelLayout(screenToolbarSurface, "Mobile screen context toolbar");
const mobileToolbarActionBar = screenToolbarSurface.locator(":scope > div:first-child");
const mobileFirstToolbarAction = mobileToolbarActionBar.locator(":scope > button").first();
const mobileFirstToolbarActionBounds = await mobileFirstToolbarAction.boundingBox();
const mobileToolbarScrollLeft = await mobileToolbarActionBar.evaluate((element) => element.scrollLeft);
assert(mobileToolbarScrollLeft <= 1, `Mobile screen context toolbar must start at the first action: ${mobileToolbarScrollLeft}px`);
assert(
  mobileFirstToolbarActionBounds
    && mobileFirstToolbarActionBounds.x >= 0
    && mobileFirstToolbarActionBounds.x + mobileFirstToolbarActionBounds.width <= 390,
  `Mobile screen context first action must fit the viewport: ${JSON.stringify(mobileFirstToolbarActionBounds)}`,
);
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: mobileScreenContextToolbarScreenshot,
});
await screenToolbar.getByRole("button", { name: "More" }).click();
const mobileMoreMenu = screenToolbar.getByRole("menu");
await mobileMoreMenu.waitFor();
await assertCanvasPanelLayout(mobileMoreMenu, "Mobile screen context More menu");
await screenToolbar.getByRole("button", { name: "More" }).click();
await mobileMoreMenu.waitFor({ state: "detached" });

await page.getByRole("button", { name: "Design system" }).click();
await waitForAsyncValue(
  () => designSystemPanel.getAttribute("aria-busy").then((value) => value === "false"),
  "Mobile Design system readiness",
);
assert(await designSystemPanel.getByRole("alert").count() === 0, "Mobile Design system must open without an error state");
await assertCanvasPanelLayout(designSystemPanel, "Mobile Design system panel");
await page.screenshot({
  animations: "disabled",
  caret: "hide",
  fullPage: true,
  path: mobileDesignSystemPanelScreenshot,
});
await page.getByRole("button", { name: "关闭 Design system" }).click();
await designSystemPanel.waitFor({ state: "detached" });

await page.setViewportSize({ width: 320, height: 720 });
await page.waitForTimeout(250);
const narrowComposerBounds = await composer.boundingBox();
assert(narrowComposerBounds, "Project Composer must remain visible at 320px");
assert(
  narrowComposerBounds.x >= 0 && narrowComposerBounds.x + narrowComposerBounds.width <= 320,
  "Project Composer must fit the 320px viewport",
);
const narrowToolbarOverflow = await composer.locator("[data-project-composer-toolbar]").evaluate(
  (element) => element.scrollWidth - element.clientWidth,
);
assert(
  narrowToolbarOverflow <= 1,
  `Project Composer toolbar must not overflow at 320px: ${narrowToolbarOverflow}px`,
);

const fixedViewportAudit = await runFixedViewportAudit();
const homeMobileDrawerAudit = await runHomeMobileDrawerAudit();

assert(unknownRequests.length === 0, `Unhandled API requests: ${unknownRequests.join(", ")}`);
assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);
assert(saves.length === 6, `Frame/Create, two Pan viewport changes, Freehand, Undo and Redo must produce exactly six saves; received ${saves.length}`);

console.log(JSON.stringify({
  ok: true,
  saveCount: saves.length,
  finalRevision: board.revision,
  frameNodeId: frameNode.id,
  drawingNodeId: drawingNode.id,
  drawingPointCount: drawingNode.data.stroke.points.length,
  uploadRetryResumedOriginalSubmission: uploadSessionAttempts === 2 && submittedIntentRunRequests.length === 1,
  submissionIntentCreated: createdSubmissionIntentRequests.length,
  submissionIntentSubmitted: submittedSubmissionIntentIds.length,
  targetSurface: submittedIntentRunRequests[0].targetSurface,
  memberRoleUpdates: memberRoleUpdates.length,
  artifactPreferenceUpdates: artifactPreferenceUpdates.length,
  artifactPreferenceIfMatches,
  maxArtifactPreferencePutsInFlight,
  artifactPreferenceRefreshRestored: artifactPreference.favorite && artifactPreference.reaction === "like",
  stage2SaveCounts,
  multiScreenPreviewSelections: previewSelections,
  fixedViewportAudit,
  homeMobileDrawerAudit,
  screenshots: [
    projectBaselineScreenshot,
    "output/playwright/workbench-board-tools-desktop-1501x855.png",
    "output/playwright/workbench-board-tools-mobile-390x844.png",
    desktopScreenContextToolbarScreenshot,
    mobileScreenContextToolbarScreenshot,
    desktopFavouritesPanelScreenshot,
    desktopDesignSystemPanelScreenshot,
    mobileFavouritesPanelScreenshot,
    mobileDesignSystemPanelScreenshot,
    ...Object.values(fixedViewportScreenshotPaths),
    homeMobileDrawerScreenshot,
  ],
}, null, 2));

await browser.close();

function prototypeDocumentFixture() {
  const literal = (value) => ({ kind: "literal", value });
  const document = {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-board-tools",
    title: "Reference Screen",
    revision: 1,
    screens: [
      {
        id: "screen-home",
        name: "Home",
        route: "/",
        rootNodeId: "frame-home",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
      {
        id: "screen-checkout",
        name: "Checkout",
        route: "/checkout",
        rootNodeId: "frame-checkout",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
    ],
    nodes: [{
      id: "frame-home",
      screenId: "screen-home",
      parentId: null,
      name: "Home",
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "flex",
        direction: "column",
        gap: literal(8),
        padding: {
          top: literal(16),
          right: literal(16),
          bottom: literal(16),
          left: literal(16),
        },
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
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame",
      childIds: [],
      clipContent: true,
    }, {
      id: "frame-checkout",
      screenId: "screen-checkout",
      parentId: null,
      name: "Checkout",
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "flex",
        direction: "column",
        gap: literal(8),
        padding: {
          top: literal(16),
          right: literal(16),
          bottom: literal(16),
          left: literal(16),
        },
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
      actionIds: [],
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
    actions: [],
    bindings: [],
    motions: [],
  };
  document.screens.push({
    ...structuredClone(document.screens[1]),
    id: "screen-settings",
    name: "Settings",
    route: "/settings",
    rootNodeId: "frame-settings",
  });
  document.nodes.push({
    ...structuredClone(document.nodes[1]),
    id: "frame-settings",
    screenId: "screen-settings",
    name: "Settings",
  });
  if (runnablePreviewEnabled) {
    document.actions = document.nodes.map((node, index) => ({
      id: `action-${index + 1}`,
      nodeId: node.id,
      event: "click",
      kind: "navigate",
      targetScreenId: document.screens[(index + 1) % document.screens.length].id,
    }));
    document.nodes.forEach((node, index) => {
      node.actionIds = [document.actions[index].id];
    });
  }
  return document;
}

function projectPreviewFixture(id, selection) {
  return {
    id,
    projectId: project.id,
    boardId: board.id,
    boardRevision: board.revision,
    selection,
    status: "succeeded",
    revision: 0,
    failure: null,
    createdAt: timestamp,
    expiresAt: "2099-01-01T00:00:00.000Z",
    updatedAt: timestamp,
  };
}

function uploadFileFixture(status) {
  const ready = status === "ready";
  const extraction = ready ? {
    id: "extraction-upload-1",
    fileAssetId: "file-upload-1",
    attempt: 1,
    status: "ready",
    parser: "docling-serve",
    parserVersion: "docling-serve/1.26.0",
    outputSchemaVersion: 1,
    contentSha256: "c".repeat(64),
    failure: null,
    startedAt: timestamp,
    finishedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  } : null;
  return {
    id: "file-upload-1",
    projectId: project.id,
    blobId: status === "uploading" ? null : "blob-upload-1",
    originalName: "retry-brief.txt",
    declaredMediaType: "text/plain",
    detectedMediaType: ready ? "text/plain" : null,
    byteSize: 13,
    status,
    revision: status === "uploading" ? 0 : status === "verifying" ? 1 : 2,
    sha256: ready ? "b".repeat(64) : null,
    failure: null,
    currentExtraction: extraction,
    latestExtraction: extraction,
    verifiedAt: ready ? timestamp : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function uploadSessionFixture(status) {
  return {
    id: "upload-session-1",
    fileAssetId: "file-upload-1",
    status,
    partSize: 5 * 1024 * 1024,
    revision: status === "completed" ? 2 : 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function runFixture(body) {
  return {
    id: "run-upload-1",
    requestId: "request-upload-1",
    projectId: project.id,
    threadId: thread.id,
    retryOfRunId: null,
    status: "succeeded",
    modelId: body.modelId,
    workflow: body.workflow,
    generationIntent: body.generationIntent ?? null,
    targetSurface: body.targetSurface,
    designStyle: body.designStyle,
    artifactTargets: body.artifactTargets,
    requestedArtifactKinds: body.requestedArtifactKinds,
    sources: [{
      id: "run-source-upload-1",
      runId: "run-upload-1",
      projectId: project.id,
      position: 0,
      sourceId: "source-file-upload-1",
      kind: "file",
      label: "retry-brief.txt",
      checksum: "b".repeat(64),
      descriptor: {
        kind: "file",
        fileAssetId: "file-upload-1",
        originalName: "retry-brief.txt",
        mediaType: "text/plain",
      },
      snapshot: {
        protocol: "workbench.import-source-snapshot.v1",
        sourceRevision: 1,
        checksum: "b".repeat(64),
        blobs: [{
          position: 0,
          blobId: "blob-upload-1",
          role: "primary",
          path: "retry-brief.txt",
          mediaType: "text/plain",
          byteSize: 13,
          sha256: "b".repeat(64),
        }],
      },
      createdAt: timestamp,
    }],
    knowledgeReleaseId: null,
    phase: "publishing",
    phaseLabel: "文件已处理",
    progress: 1,
    attempt: 1,
    lastEventSequence: 0,
    cancelRequestedAt: null,
    failure: null,
    cancellationReason: null,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
  };
}

function pendingSubmissionIntentFixture(body) {
  return {
    id: "intent-upload-1",
    projectId: project.id,
    threadId: thread.id,
    status: "pending",
    request: body.request,
    attachments: body.attachments.map((attachment, position) => ({
      ...attachment,
      position,
      fileAssetId: null,
      fileStatus: null,
    })),
    runId: null,
    lastFailure: null,
    revision: 1,
    submittedAt: null,
    cancelledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function submittedSubmissionIntentFixture(intent) {
  return {
    ...intent,
    status: "submitted",
    attachments: intent.attachments.map((attachment) => ({
      ...attachment,
      fileAssetId: "file-upload-1",
      fileStatus: "ready",
    })),
    runId: "run-upload-1",
    revision: 2,
    submittedAt: timestamp,
    updatedAt: timestamp,
  };
}

async function assertCanvasPanelLayout(panel, label) {
  const viewport = page.viewportSize();
  assert(viewport, `${label} requires a fixed Playwright viewport`);
  await page.mouse.move(viewport.width / 2, Math.min(140, viewport.height / 4));
  const panelBounds = await waitForStableElementBounds(panel, label);
  const railBounds = await page.locator("[data-right-tool-rail]").boundingBox();
  const composerBounds = await page.locator("[data-project-composer]").boundingBox();
  assert(railBounds, `${label} requires the right tool rail to be visible`);
  assert(composerBounds, `${label} requires the Project Composer to be visible`);

  const tolerance = 1;
  assert(
    panelBounds.x >= -tolerance
      && panelBounds.y >= -tolerance
      && panelBounds.x + panelBounds.width <= viewport.width + tolerance
      && panelBounds.y + panelBounds.height <= viewport.height + tolerance,
    `${label} must fit the viewport: ${JSON.stringify({ panelBounds, viewport })}`,
  );
  assert(
    !rectanglesOverlap(panelBounds, railBounds),
    `${label} must not overlap the right tool rail: ${JSON.stringify({ panelBounds, railBounds })}`,
  );
  assert(
    !rectanglesOverlap(panelBounds, composerBounds),
    `${label} must not overlap the Project Composer: ${JSON.stringify({ panelBounds, composerBounds })}`,
  );
}

/**
 * Stage 11 keeps a small, deterministic viewport matrix next to the full board
 * interaction smoke. The audit deliberately reuses the already hydrated page
 * so every assertion observes the same real Board/Composer state and API
 * fixture, while each PNG is captured at the exact requested viewport size.
 */
async function runFixedViewportAudit() {
  const results = [];
  // The interaction smoke ends after a deliberate Pan gesture. Reset only the
  // in-memory fixture viewport before visual capture so the fixed matrix shows
  // a real Board node on every device without creating another save revision.
  board = {
    ...board,
    viewport: { x: 70, y: 80, zoom: 0.63 },
  };
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-workbench-project]").waitFor();
  await page.waitForTimeout(450);
  const stage = page.locator("[data-workbench-stage]");
  const rail = page.locator("[data-right-tool-rail]");
  const utility = page.locator("[data-utility-pill]");
  const screenToolbarAudit = page.locator("[data-screen-context-toolbar-surface]");
  const auditComposer = page.locator("[data-project-composer]");
  const baseElements = [
    [stage, "Workbench stage"],
    [rail, "Canvas tool rail"],
    [utility, "Canvas utility bar"],
    [auditComposer, "Project Composer"],
  ];

  await dismissFixedViewportOverlays();
  for (const viewport of fixedViewportMatrix) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(450);
    await dismissFixedViewportOverlays();

    const measured = {};
    for (const [locator, label] of baseElements) {
      measured[label] = await assertViewportBounds(locator, label, viewport);
    }
    assert(
      !rectanglesOverlap(measured["Canvas tool rail"], measured["Project Composer"]),
      `${viewport.key} rail must not overlap Project Composer: ${JSON.stringify(measured)}`,
    );
    assert(
      !rectanglesOverlap(measured["Canvas utility bar"], measured["Project Composer"]),
      `${viewport.key} utility bar must not overlap Project Composer: ${JSON.stringify(measured)}`,
    );

    if (await screenToolbarAudit.isVisible().catch(() => false)) {
      measured["Screen context toolbar"] = await assertViewportBounds(
        screenToolbarAudit,
        "Screen context toolbar",
        viewport,
      );
    }

    const screenshotPath = fixedViewportScreenshotPaths[viewport.key];
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      path: screenshotPath,
    });
    const pixels = await assertNonEmptyCanvasScreenshot(
      screenshotPath,
      measured["Workbench stage"],
      viewport,
    );

    await page.getByRole("button", { name: "项目菜单" }).click();
    const projectMenu = page.locator('[data-project-menu][role="menu"]');
    await projectMenu.waitFor({ state: "visible" });
    const projectMenuBounds = await assertViewportBounds(projectMenu, "Project menu", viewport);
    await page.keyboard.press("Escape");
    await projectMenu.waitFor({ state: "detached" }).catch(() => undefined);

    await page.getByRole("button", { name: "项目菜单" }).click();
    await page.getByRole("menuitem", { name: "成员与权限", exact: true }).click();
    const membersDialogAudit = page.locator("[data-project-members-dialog]");
    await membersDialogAudit.waitFor({ state: "visible" });
    const membersDialogBounds = await assertViewportBounds(
      membersDialogAudit,
      "Project members dialog",
      viewport,
    );
    await page.keyboard.press("Escape");
    await membersDialogAudit.waitFor({ state: "detached" }).catch(() => undefined);

    await composer.getByRole("button", { name: "添加附件" }).click();
    const attachmentMenu = composer.getByRole("menu");
    await attachmentMenu.waitFor({ state: "visible" });
    const attachmentMenuBounds = await assertViewportBounds(
      attachmentMenu,
      "Composer attachment menu",
      viewport,
    );
    await attachmentMenu
      .getByRole("menuitem", { name: "添加网站 / GitHub / Figma", exact: true })
      .click();
    const importDialogAudit = page.locator("[data-import-sources-dialog]");
    await importDialogAudit.waitFor({ state: "visible" });
    const importDialogBounds = await assertViewportBounds(
      importDialogAudit,
      "Import Source dialog",
      viewport,
    );
    await page.keyboard.press("Escape");
    await importDialogAudit.waitFor({ state: "detached" }).catch(() => undefined);

    await page.getByRole("button", { name: "Favourites" }).click();
    const favouritesAudit = page.locator("[data-workbench-canvas-favourites-panel]");
    await favouritesAudit.waitFor({ state: "visible" });
    await favouritesAudit.getByText("Home", { exact: true }).waitFor();
    const favouritesBounds = await assertViewportBounds(
      favouritesAudit,
      "Favourites panel",
      viewport,
    );
    await assertCanvasPanelLayout(favouritesAudit, `${viewport.key} Favourites panel`);
    await page.getByRole("button", { name: "关闭 Favourites" }).click();
    await favouritesAudit.waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Design system" }).click();
    const designSystemAudit = page.locator("[data-workbench-canvas-design-system-panel]");
    await waitForAsyncValue(
      () => designSystemAudit.getAttribute("aria-busy").then((value) => value === "false"),
      `${viewport.key} Design system readiness`,
    );
    const designSystemBounds = await assertViewportBounds(
      designSystemAudit,
      "Design system panel",
      viewport,
    );
    await assertCanvasPanelLayout(designSystemAudit, `${viewport.key} Design system panel`);
    await page.getByRole("button", { name: "关闭 Design system" }).click();
    await designSystemAudit.waitFor({ state: "detached" });

    await dismissFixedViewportOverlays();
    results.push({
      viewport: `${viewport.width}x${viewport.height}`,
      screenshot: screenshotPath,
      screenshotPixels: pixels,
      bounds: {
        stage: measured["Workbench stage"],
        rail: measured["Canvas tool rail"],
        utility: measured["Canvas utility bar"],
        composer: measured["Project Composer"],
        screenToolbar: measured["Screen context toolbar"] ?? null,
        projectMenu: projectMenuBounds,
        membersDialog: membersDialogBounds,
        attachmentMenu: attachmentMenuBounds,
        importDialog: importDialogBounds,
        favourites: favouritesBounds,
        designSystem: designSystemBounds,
      },
    });
  }
  await dismissFixedViewportOverlays();
  return results;
}

async function runHomeMobileDrawerAudit() {
  const viewport = { key: "mobile-home", width: 375, height: 812 };
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${origin}/?fixedViewportAudit=1#home`, { waitUntil: "networkidle" });
  const drawer = page.locator("[data-home-project-drawer-open]");
  await drawer.waitFor({ state: "attached" });
  await page.waitForTimeout(350);
  assert(
    await drawer.getAttribute("data-home-project-drawer-open") === "false",
    "Home mobile project drawer must start closed",
  );
  const closedBounds = await waitForStableElementBounds(drawer, "Closed Home mobile project drawer");
  assert(
    Math.abs(closedBounds.x) <= 2
      && Math.abs(closedBounds.y - viewport.height) <= 2
      && Math.abs(closedBounds.width - viewport.width) <= 2
      && Math.abs(closedBounds.height - (viewport.height - 80)) <= 2,
    `Closed Home mobile project drawer must sit immediately below the viewport: ${JSON.stringify({ closedBounds, viewport })}`,
  );
  const transition = await drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      duration: style.transitionDuration,
      pointerEvents: style.pointerEvents,
      property: style.transitionProperty,
    };
  });
  assert(
    transition.pointerEvents === "none",
    `Closed Home mobile project drawer must ignore pointer events: ${JSON.stringify(transition)}`,
  );
  assert(
    transition.property.split(",").map((value) => value.trim()).includes("transform")
      && transition.duration.split(",").map((value) => value.trim()).includes("0.3s"),
    `Home mobile project drawer must use a 300ms transform transition: ${JSON.stringify(transition)}`,
  );

  const trigger = page.getByRole("button", { name: "项目列表" });
  await trigger.click();
  await waitForAsyncValue(
    () => drawer.getAttribute("data-home-project-drawer-open").then((value) => value === "true"),
    "Open Home mobile project drawer state",
  );
  const openBounds = await assertViewportBounds(drawer, "Open Home mobile project drawer", viewport);
  assert(
    Math.abs(openBounds.x) <= 2
      && Math.abs(openBounds.y - 80) <= 2
      && Math.abs(openBounds.width - viewport.width) <= 2
      && Math.abs(openBounds.height - (viewport.height - 80)) <= 2,
    `Open Home mobile project drawer must occupy viewport minus the 80px top reveal: ${JSON.stringify({ openBounds, viewport })}`,
  );
  assert(
    await trigger.getAttribute("aria-expanded") === "true",
    "Home mobile project drawer trigger must expose aria-expanded=true",
  );
  const scrollRegion = drawer.locator(".overflow-y-auto").first();
  await scrollRegion.waitFor({ state: "visible" });
  const scrollMetrics = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  assert(
    scrollMetrics.clientHeight > 0 && scrollMetrics.overflowY === "auto",
    `Home mobile project drawer must retain its scroll region: ${JSON.stringify(scrollMetrics)}`,
  );
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: homeMobileDrawerScreenshot,
  });
  const screenshotPixels = await assertNonEmptyCanvasScreenshot(
    homeMobileDrawerScreenshot,
    openBounds,
    viewport,
  );
  return {
    viewport: `${viewport.width}x${viewport.height}`,
    screenshot: homeMobileDrawerScreenshot,
    screenshotPixels,
    closedBounds,
    openBounds,
    scrollMetrics,
    transition,
  };
}

async function dismissFixedViewportOverlays() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  }
  const closeButtons = [
    ["[data-workbench-canvas-favourites-panel]", "关闭 Favourites"],
    ["[data-workbench-canvas-design-system-panel]", "关闭 Design system"],
  ];
  for (const [panelSelector, label] of closeButtons) {
    const panel = page.locator(panelSelector);
    if (await panel.isVisible().catch(() => false)) {
      const close = panel.getByRole("button", { name: label });
      if (await close.isVisible().catch(() => false)) await close.click();
      await panel.waitFor({ state: "detached" }).catch(() => undefined);
    }
  }
}

async function assertViewportBounds(locator, label, viewport) {
  const bounds = await waitForStableElementBounds(locator, `${label} at ${viewport.width}x${viewport.height}`);
  const tolerance = 2;
  assert(
    bounds.width > 0
      && bounds.height > 0
      && bounds.x >= -tolerance
      && bounds.y >= -tolerance
      && bounds.x + bounds.width <= viewport.width + tolerance
      && bounds.y + bounds.height <= viewport.height + tolerance,
    `${label} must fit ${viewport.width}x${viewport.height}: ${JSON.stringify({ bounds, viewport })}`,
  );
  return bounds;
}

async function assertNonEmptyCanvasScreenshot(path, stageBounds, viewport) {
  const image = sharp(path);
  const metadata = await image.metadata();
  assert(
    metadata.width === viewport.width && metadata.height === viewport.height,
    `Fixed viewport screenshot must be exact ${viewport.width}x${viewport.height}: ${JSON.stringify(metadata)}`,
  );
  const left = Math.max(0, Math.min(viewport.width - 1, Math.floor(stageBounds.x)));
  const top = Math.max(0, Math.min(viewport.height - 1, Math.floor(stageBounds.y)));
  const right = Math.max(left + 1, Math.min(viewport.width, Math.ceil(stageBounds.x + stageBounds.width)));
  const bottom = Math.max(top + 1, Math.min(viewport.height, Math.ceil(stageBounds.y + stageBounds.height)));
  const width = right - left;
  const height = bottom - top;
  const { data, info } = await image
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let nonEmptyPixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? red;
    const blue = data[offset + 2] ?? red;
    const brightest = Math.max(red, green, blue);
    const darkest = Math.min(red, green, blue);
    if (brightest >= 52 || brightest - darkest >= 8) nonEmptyPixels += 1;
  }
  const stats = await image.extract({ left, top, width, height }).stats();
  const maxStdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  assert(
    nonEmptyPixels >= 128 && stats.entropy >= 0.4 && maxStdev >= 2,
    `Canvas screenshot must contain rendered pixels at ${viewport.width}x${viewport.height}: ${JSON.stringify({
      crop: { left, top, width, height },
      entropy: stats.entropy,
      maxStdev,
      nonEmptyPixels,
    })}`,
  );
  return {
    crop: { left, top, width, height },
    entropy: Number(stats.entropy.toFixed(4)),
    maxStdev: Number(maxStdev.toFixed(4)),
    nonEmptyPixels,
  };
}

async function waitForStableElementBounds(locator, label) {
  await locator.waitFor({ state: "visible" });
  const startedAt = Date.now();
  let previous = null;
  let current = null;
  let stableSamples = 0;
  while (Date.now() - startedAt < 6_000) {
    current = await locator.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        opacity: Number(style.opacity),
        transform: style.transform,
      };
    });
    stableSamples = previous && visualLayoutSamplesMatch(previous, current)
      ? stableSamples + 1
      : 0;
    if (stableSamples >= 3) {
      return {
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height,
      };
    }
    previous = current;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} animation did not settle: ${JSON.stringify(current)}`);
}

function contextMenuItem(menu, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return menu.locator('button[role^="menuitem"]').filter({
    hasText: new RegExp(`^${escaped}$`, "u"),
  });
}

function visualLayoutSamplesMatch(left, right) {
  const tolerance = 0.25;
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance
    && Math.abs(left.opacity - right.opacity) <= 0.01
    && left.transform === right.transform;
}

function rectanglesOverlap(left, right) {
  const tolerance = 0.5;
  return left.x < right.x + right.width - tolerance
    && left.x + left.width > right.x + tolerance
    && left.y < right.y + right.height - tolerance
    && left.y + left.height > right.y + tolerance;
}

async function waitForBoard(predicate, label) {
  const startedAt = Date.now();
  while (!predicate(board) && Date.now() - startedAt < 6_000) {
    await page.waitForTimeout(50);
  }
  assert(predicate(board), `${label} did not reach the fixture Board; ${JSON.stringify({
    saves: saves.map((saved) => ({ revision: saved.revision, kinds: saved.nodes.map((node) => node.kind) })),
    board: { revision: board.revision, kinds: board.nodes.map((node) => node.kind) },
  })}`);
}

async function waitForStage2Save(label, predicate) {
  assert(!(label in stage2SaveCounts), `Stage 2 save label must be unique: ${label}`);
  const previousTotal = Object.values(stage2SaveCounts)
    .reduce((total, count) => total + count, 0);
  const expectedTotal = previousTotal + 1;
  await waitForBoard(predicate, label);
  await waitForValue(() => saves.length >= expectedTotal, `${label} save`);
  await page.waitForTimeout(150);
  assert(
    saves.length === expectedTotal,
    `${label} must save exactly once; received ${saves.length - previousTotal}`,
  );
  stage2SaveCounts[label] = 1;
}

async function waitForValue(predicate, label) {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < 6_000) {
    await page.waitForTimeout(50);
  }
  assert(predicate(), `${label} did not reach the expected state`);
}

async function waitForAsyncValue(predicate, label) {
  const startedAt = Date.now();
  while (!(await predicate()) && Date.now() - startedAt < 6_000) {
    await page.waitForTimeout(50);
  }
  assert(await predicate(), `${label} did not reach the expected state`);
}

async function waitForSelectedNodeIds(expectedNodeIds, label) {
  const expected = [...expectedNodeIds].sort();
  const startedAt = Date.now();
  let actual = await selectedNodeIds();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() - startedAt < 6_000) {
    await page.waitForTimeout(50);
    actual = await selectedNodeIds();
  }
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must select the exact Board node IDs: ${JSON.stringify({ expected, actual })}`,
  );
}

async function selectedNodeIds() {
  const nodeIds = await page.locator(".react-flow__node.selected").evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute("data-id"))
  ));
  return nodeIds.filter((nodeId) => typeof nodeId === "string").sort();
}

function boardNodePositionProjection(value) {
  return value.nodes
    .map((node) => ({
      id: node.id,
      parentNodeId: node.parentNodeId,
      position: node.position,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function boardNodePositionProjectionForIds(value, nodeIds) {
  const requestedIds = new Set(nodeIds);
  return boardNodePositionProjection(value).filter((node) => requestedIds.has(node.id));
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
