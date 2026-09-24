import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const origin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const timestamp = "2026-07-15T08:00:00.000Z";
const updatedTimestamp = "2026-07-15T08:05:00.000Z";
const outputDir = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
const homeBaselineScreenshot = path.join(outputDir, "workbench-phase0-baseline-home-1501x855.png");
const approvalScreenshot = path.join(outputDir, "workbench-approval-keyboard-1501x855.png");
const preferencesScreenshot = path.join(outputDir, "workbench-preferences-refresh-1501x855.png");
const unknownRequests = [];
const consoleErrors = [];
const approvalSubmissions = [];
const approvalListSnapshots = [];
const bootstrapRunStatuses = [];
const streamCursors = [];
const preferenceGetRevisions = [];
const preferenceUpdates = [];

const project = {
  id: "project-approval-keyboard",
  workspaceId: "workspace-1",
  title: "键盘审批验收项目",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const thread = {
  id: "thread-approval-keyboard",
  projectId: project.id,
  title: "键盘审批验收",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const board = {
  id: "board-approval-keyboard",
  projectId: project.id,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 0.8 },
  nodes: [],
  edges: [],
};
const waitingRun = {
  id: "run-approval-keyboard",
  requestId: "request-approval-keyboard",
  projectId: project.id,
  threadId: thread.id,
  retryOfRunId: null,
  status: "waiting_input",
  modelId: "model-approval",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  artifactTargets: [],
  requestedArtifactKinds: [],
  sources: [],
  knowledgeReleaseId: null,
  phase: null,
  phaseLabel: null,
  progress: 0.4,
  attempt: 1,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: timestamp,
  startedAt: timestamp,
  finishedAt: null,
};
let currentRun = waitingRun;

const approvals = [
  {
    id: "approval-layout",
    runId: waitingRun.id,
    kind: "choice",
    prompt: "请选择界面布局密度",
    options: [
      {
        id: "layout-balanced",
        label: "均衡布局",
        description: "保留十二列信息结构",
        value: { layout: { columns: 12, density: "balanced" }, preserveMotion: true },
      },
      {
        id: "layout-focused",
        label: "聚焦布局",
        description: "收敛为八列核心任务区",
        value: { layout: { columns: 8, density: "focused" }, preserveMotion: true },
      },
    ],
    attempt: 1,
    status: "pending",
    response: null,
    decidedById: null,
    decidedAt: null,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: "approval-execution",
    runId: waitingRun.id,
    kind: "choice",
    prompt: "请选择后续执行方式",
    options: [
      {
        id: "execution-continuous",
        label: "连续执行",
        description: "直接完成剩余产物",
        value: { execution: { checkpoints: [], mode: "continuous" }, notify: false },
      },
      {
        id: "execution-staged",
        label: "分阶段继续",
        description: "在 PRD 与原型节点保留检查点",
        value: {
          execution: { checkpoints: ["prd", "prototype"], mode: "staged" },
          notify: false,
        },
      },
    ],
    attempt: 1,
    status: "pending",
    response: null,
    decidedById: null,
    decidedAt: null,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

let preferences = {
  productUpdatesEmail: false,
  researchInvitations: true,
  revision: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};
let releaseRunStream;
const runStreamReady = new Promise((resolve) => {
  releaseRunStream = resolve;
});

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1501, height: 855 } });
  await installAuthenticatedSession(context);
  await context.route("**/api/v1/**", routeWorkbenchApi);

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(`${message.text()} @ ${JSON.stringify(message.location())}`);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /欢迎使用产品工作台/u }).waitFor();
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: homeBaselineScreenshot,
  });

  await page.goto(`${origin}/projects/${encodeURIComponent(project.id)}`, {
    waitUntil: "domcontentloaded",
  });
  assert(await page.title() === "产品工作台", "browser title must use 产品工作台");
  await page.locator("[data-workbench-project]").waitFor();

  const firstDialog = page.getByRole("dialog", { name: "需要您的确认" });
  await firstDialog.waitFor();
  await firstDialog.getByText(approvals[0].prompt, { exact: true }).waitFor();
  const firstRadios = firstDialog.getByRole("radio");
  assert(await firstRadios.count() === 2, "the first approval must expose two real radio options");
  await waitForFocus(page, firstRadios.nth(0), "first approval radio-group entry");

  await page.keyboard.press("ArrowDown");
  await waitForFocus(page, firstRadios.nth(1), "ArrowDown radio focus");
  await page.keyboard.press("Space");
  await waitForChecked(firstRadios.nth(1), page, "ArrowDown approval selection");
  assert(
    await firstRadios.nth(1).getAttribute("aria-checked") === "true",
    "ArrowDown must select the second structured approval option",
  );

  await page.keyboard.press("Tab");
  await assertFocused(firstDialog.getByRole("button", { name: "拒绝" }), "approval reject button");
  await page.keyboard.press("Tab");
  await assertFocused(firstDialog.getByRole("button", { name: "确认选择" }), "approval submit button");
  await page.keyboard.press("Tab");
  await assertFocused(firstRadios.nth(1), "focus trap radio return");

  await page.keyboard.press("Escape");
  assert(await firstDialog.isVisible(), "Escape must not close a blocking approval");
  assert(approvalSubmissions.length === 0, "Escape must not submit or bypass a blocking approval");
  await page.screenshot({ path: approvalScreenshot, fullPage: true });

  await waitForFocus(page, firstRadios.nth(1), "Escape retained approval focus");
  await page.keyboard.press("Tab");
  await waitForFocus(
    page,
    firstDialog.getByRole("button", { name: "拒绝" }),
    "Enter traversal reject target",
  );
  await page.keyboard.press("Tab");
  await waitForFocus(
    page,
    firstDialog.getByRole("button", { name: "确认选择" }),
    "Enter submit target",
  );
  await page.keyboard.press("Enter");
  await waitForValue(() => approvalSubmissions.length === 1, page, "first approval Enter submission");
  assertStructuredSubmission(approvalSubmissions[0].body, {
    decision: "submit",
    value: approvals[0].options[1].value,
  }, "Enter");

  const secondDialog = page.getByRole("dialog", { name: "需要您的确认" });
  await secondDialog.getByText(approvals[1].prompt, { exact: true }).waitFor();
  const secondRadios = secondDialog.getByRole("radio");
  await enterRadioGroupWithKeyboard(page, secondRadios.nth(0));
  await page.keyboard.press("ArrowDown");
  await waitForFocus(page, secondRadios.nth(1), "second ArrowDown radio focus");
  await page.keyboard.press("Space");
  await waitForChecked(secondRadios.nth(1), page, "second approval ArrowDown selection");
  await page.keyboard.press("Tab");
  await assertFocused(secondDialog.getByRole("button", { name: "拒绝" }), "second reject button");
  await page.keyboard.press("Tab");
  const spaceSubmit = secondDialog.getByRole("button", { name: "确认选择" });
  await assertFocused(spaceSubmit, "Space submit target");
  await page.keyboard.press("Space");

  await waitForValue(() => approvalSubmissions.length === 2, page, "second approval Space submission");
  assertStructuredSubmission(approvalSubmissions[1].body, {
    decision: "submit",
    value: approvals[1].options[1].value,
  }, "Space");
  await secondDialog.waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText("正在运行", { exact: true }).waitFor();
  assert(
    bootstrapRunStatuses.includes("queued"),
    `the authoritative bootstrap must observe the resumed queued Run: ${bootstrapRunStatuses.join(", ")}`,
  );
  assert(
    streamCursors[0] === 0,
    `the resumed Run event stream must start at sequence zero: ${streamCursors.join(", ")}`,
  );

  await page.setViewportSize({ width: 1501, height: 855 });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /欢迎使用产品工作台/u }).waitFor();
  await page.getByRole("button", { name: "消息订阅" }).click();
  const preferencePolicyCopy = "须遵守产品工作台服务条款和使用政策。您可以随时在产品工作台账户中管理这些偏好。";
  const initialPreferencePanel = page.getByText(preferencePolicyCopy, { exact: true }).locator("..");
  await waitForOpaque(initialPreferencePanel, page, "initial communication preferences panel");
  const initialCheckboxes = page.getByRole("checkbox");
  assert(await initialCheckboxes.count() === 2, "communication preferences must expose two checkboxes");
  assert(!(await initialCheckboxes.nth(0).isChecked()), "product updates must reflect the initial false value");
  assert(await initialCheckboxes.nth(1).isChecked(), "research invitations must reflect the initial true value");

  await initialCheckboxes.nth(0).click();
  await waitForValue(() => preferenceUpdates.length === 1, page, "strong-ETag preference update");
  assert(
    preferenceUpdates[0].ifMatch === '"3"',
    `communication preferences PUT must send the current strong ETag: ${preferenceUpdates[0].ifMatch}`,
  );
  assertStructuredSubmission(preferenceUpdates[0].body, {
    productUpdatesEmail: true,
    researchInvitations: true,
  }, "communication preferences PUT");

  await page.reload({ waitUntil: "networkidle" });
  await waitForValue(
    () => preferenceGetRevisions.at(-1) === 4,
    page,
    "authoritative communication preferences refresh",
  );
  await page.getByRole("button", { name: "消息订阅" }).click();
  const refreshedPreferencePanel = page.getByText(preferencePolicyCopy, { exact: true }).locator("..");
  await waitForOpaque(refreshedPreferencePanel, page, "refreshed communication preferences panel");
  const refreshedCheckboxes = page.getByRole("checkbox");
  assert(await refreshedCheckboxes.nth(0).isChecked(), "product updates must survive a full page refresh");
  assert(await refreshedCheckboxes.nth(1).isChecked(), "research invitations must survive a full page refresh");
  await page.screenshot({ path: preferencesScreenshot, fullPage: true });

  assert(
    preferenceGetRevisions.length >= 2
      && preferenceGetRevisions[0] === 3
      && preferenceGetRevisions.at(-1) === 4,
    `preferences must GET revision 3 then authoritative revision 4: ${preferenceGetRevisions.join(", ")}`,
  );
  assert(
    approvalListSnapshots.some((snapshot) => snapshot.join(",") === "submitted,pending")
      && approvalListSnapshots.at(-1)?.join(",") === "submitted,submitted",
    `approval invalidation must expose each durable decision: ${JSON.stringify(approvalListSnapshots)}`,
  );
  assert(unknownRequests.length === 0, `Unhandled API requests: ${unknownRequests.join(", ")}`);
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);

  console.log(JSON.stringify({
    ok: true,
    approvalDecisions: approvalSubmissions.map(({ approvalId, body }) => ({ approvalId, body })),
    approvalListSnapshots,
    bootstrapRunStatuses,
    preferenceGetRevisions,
    preferenceUpdate: preferenceUpdates[0],
    streamCursors,
    screenshots: [
      "output/playwright/workbench-phase0-baseline-home-1501x855.png",
      "output/playwright/workbench-approval-keyboard-1501x855.png",
      "output/playwright/workbench-preferences-refresh-1501x855.png",
    ],
  }, null, 2));
} finally {
  releaseRunStream();
  await browser.close();
}

async function installAuthenticatedSession(context) {
  await context.addCookies([{
    name: "workbench.session_token",
    value: "approval-preferences-session",
    url: origin,
  }]);
  await context.route("**/api/auth/**", async (route) => {
    await json(route, {
      session: {
        id: "session-approval-preferences",
        token: "approval-preferences-session",
        userId: "principal-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
        ipAddress: null,
        userAgent: "Playwright",
      },
      user: {
        id: "principal-1",
        name: "Keyboard Reviewer",
        email: "keyboard-reviewer@example.test",
        emailVerified: true,
        image: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  });
}

async function routeWorkbenchApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const requestPath = url.pathname;
  const method = request.method();

  if (method === "GET" && requestPath === `/api/v1/runs/${waitingRun.id}/events`) {
    const cursor = Number(url.searchParams.get("afterSequence") ?? "0");
    streamCursors.push(cursor);
    await runStreamReady;
    return sse(route, resumedRunEvents().filter((event) => event.sequence > cursor));
  }
  if (method === "GET" && requestPath === `/api/v1/runs/${waitingRun.id}`) {
    return json(route, currentRun);
  }
  if (method === "GET" && requestPath === "/api/v1/identity/me") {
    return json(route, {
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "keyboard-reviewer",
      email: "keyboard-reviewer@example.test",
      displayName: "Keyboard Reviewer",
      defaultWorkspaceId: "workspace-1",
    });
  }
  if (method === "GET" && requestPath === "/api/v1/identity/preferences") {
    preferenceGetRevisions.push(preferences.revision);
    return json(route, preferences, { etag: `"${preferences.revision}"` });
  }
  if (method === "PUT" && requestPath === "/api/v1/identity/preferences") {
    const ifMatch = request.headers()["if-match"];
    assert(ifMatch === '"3"', `preferences PUT must use strong If-Match \"3\": ${ifMatch}`);
    assert(!ifMatch.startsWith("W/"), "preferences PUT must not use a weak ETag");
    const body = request.postDataJSON();
    preferenceUpdates.push({ ifMatch, body });
    preferences = {
      ...body,
      revision: 4,
      createdAt: timestamp,
      updatedAt: updatedTimestamp,
    };
    return json(route, preferences, { etag: '"4"' });
  }
  if (method === "GET" && requestPath === "/api/v1/runtime/models") {
    return json(route, { items: [{
      id: "model-approval",
      displayName: "Approval model",
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
    bootstrapRunStatuses.push(currentRun.status);
    return json(route, {
      project,
      access: { role: "owner" },
      threads: [thread],
      selectedThreadId: thread.id,
      entries: [],
      board,
      artifacts: [],
      latestRun: currentRun,
    }, { etag: '"1"' });
  }
  if (method === "GET" && requestPath === `/api/v1/threads/${thread.id}/submission-intents/current`) {
    return json(route, { item: null });
  }
  if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/board`) {
    return json(route, board, { etag: '"1"' });
  }
  if (method === "PUT" && requestPath === `/api/v1/projects/${project.id}/canvas-agent/state`) {
    const state = request.postDataJSON();
    assert(
      state?.protocol === "workbench.canvas-client-state.v1",
      `Canvas state sync must use the current protocol: ${JSON.stringify(state)}`,
    );
    return json(route, {
      protocol: "workbench.canvas-client-state.v1",
      activeSession: false,
      canvasStateRevision: state.canvasStateRevision,
    });
  }
  if (method === "PUT" && requestPath === `/api/v1/projects/${project.id}/board`) {
    assert(request.headers()["if-match"] === '"1"', "Board autosave must use the current revision ETag");
    return json(route, { ...board, ...request.postDataJSON() }, { etag: '"1"' });
  }
  if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/releases`) {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/shares`) {
    return json(route, { items: [], activeCount: 0, nextCursor: null });
  }
  if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/exports`) {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/exports/capabilities") {
    const available = { available: true, authentication: "not_required", reasonCode: null };
    const authRequired = {
      available: false,
      authentication: "required",
      reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
    };
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
        ai_studio: {
          available: false,
          authentication: "not_required",
          reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
        },
        netlify: authRequired,
        lovable: authRequired,
        bolt: authRequired,
      },
    });
  }
  if (method === "GET" && requestPath === `/api/v1/runs/${waitingRun.id}/approvals`) {
    approvalListSnapshots.push(approvals.map((approval) => approval.status));
    return json(route, { items: approvals });
  }
  const approvalMatch = requestPath.match(
    new RegExp(`^/api/v1/runs/${waitingRun.id}/approvals/([^/]+)$`, "u"),
  );
  if (method === "POST" && approvalMatch) {
    const approvalId = decodeURIComponent(approvalMatch[1]);
    const approval = approvals.find((candidate) => candidate.id === approvalId);
    assert(approval, `submitted approval must exist: ${approvalId}`);
    assert(approval.status === "pending", `approval ${approvalId} may be submitted only once`);
    const idempotencyKey = request.headers()["idempotency-key"];
    assert(
      /^approval:[A-Za-z0-9_-]{24}$/u.test(idempotencyKey ?? ""),
      `approval requires a caller-owned Idempotency-Key: ${idempotencyKey}`,
    );
    const body = request.postDataJSON();
    approval.status = "submitted";
    approval.response = body;
    approval.decidedById = "principal-1";
    approval.decidedAt = updatedTimestamp;
    approval.revision = 1;
    approval.updatedAt = updatedTimestamp;
    const finalDecision = approvals.every((candidate) => candidate.status !== "pending");
    currentRun = finalDecision ? { ...waitingRun, status: "queued" } : waitingRun;
    approvalSubmissions.push({ approvalId, body, idempotencyKey });
    await json(route, { approval, run: currentRun }, {
      etag: '"1"',
      location: `/api/v1/runs/${waitingRun.id}`,
    }, 202);
    if (finalDecision) releaseRunStream();
    return;
  }

  unknownRequests.push(`${method} ${requestPath}`);
  return json(route, {
    type: "about:blank",
    title: "Unhandled browser fixture request",
    status: 404,
    code: "FIXTURE_ROUTE_MISSING",
  }, {}, 404);
}

function resumedRunEvents() {
  return [
    runEvent(1, "run.input.required", {
      approvalId: approvals[0].id,
      kind: approvals[0].kind,
      prompt: approvals[0].prompt,
      options: approvals[0].options,
      attempt: approvals[0].attempt,
    }),
    runEvent(2, "run.input.required", {
      approvalId: approvals[1].id,
      kind: approvals[1].kind,
      prompt: approvals[1].prompt,
      options: approvals[1].options,
      attempt: approvals[1].attempt,
    }),
    runEvent(3, "run.input.submitted", {
      approvalId: approvals[0].id,
      decision: "submit",
    }),
    runEvent(4, "run.input.submitted", {
      approvalId: approvals[1].id,
      decision: "submit",
    }),
    runEvent(5, "run.queued", { position: null }),
  ];
}

function runEvent(sequence, type, payload) {
  return {
    protocol: "workbench.run.v1",
    id: `event-approval-keyboard-${sequence}`,
    projectId: project.id,
    threadId: thread.id,
    runId: waitingRun.id,
    requestId: waitingRun.requestId,
    sequence,
    occurredAt: updatedTimestamp,
    traceId: "trace-approval-keyboard",
    type,
    payload,
  };
}

async function enterRadioGroupWithKeyboard(page, firstRadio) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isFocused(firstRadio)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard traversal did not enter the second approval radio group");
}

async function waitForFocus(page, locator, label) {
  await waitForValue(() => isFocused(locator), page, label);
}

async function assertFocused(locator, label) {
  assert(await isFocused(locator), `${label} must own document focus`);
}

async function isFocused(locator) {
  return locator.evaluate((element) => element === document.activeElement).catch(() => false);
}

async function waitForChecked(locator, page, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (await locator.getAttribute("aria-checked") === "true") return;
    await page.waitForTimeout(50);
  }
  const keyboardState = await page.locator('[role="radio"]').evaluateAll((radios) => ({
    activeText: document.activeElement?.textContent?.trim() ?? null,
    radios: radios.map((radio) => ({
      checked: radio.getAttribute("aria-checked"),
      tabIndex: radio.getAttribute("tabindex"),
      text: radio.textContent?.trim() ?? "",
    })),
  }));
  throw new Error(`${label} did not reach the checked state: ${JSON.stringify(keyboardState)}`);
}

async function waitForOpaque(locator, page, label) {
  await waitForValue(
    () => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity) >= 0.99),
    page,
    label,
  );
}

async function waitForValue(predicate, page, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (await predicate()) return;
    await page.waitForTimeout(50);
  }
  assert(await predicate(), `${label} did not reach the expected state`);
}

async function sse(route, events) {
  const body = [
    "retry: 10000\n\n",
    ...events.map((event) => (
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )),
  ].join("");
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: {
      "cache-control": "no-cache, no-store",
      "x-content-type-options": "nosniff",
    },
    body,
  });
}

async function json(route, body, headers = {}, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers,
    body: JSON.stringify(body),
  });
}

function assertStructuredSubmission(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must preserve the structured value: ${JSON.stringify(actual)}`,
  );
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
