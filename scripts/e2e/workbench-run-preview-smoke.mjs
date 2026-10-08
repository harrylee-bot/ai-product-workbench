import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import canonicalize from "canonicalize";
import { chromium } from "playwright";
import {
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
} from "@workbench/workbench-contracts";

const origin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const evidenceLevel = process.env.WORKBENCH_E2E_EVIDENCE_LEVEL ?? "fixture";
const timestamp = "2026-07-14T02:00:00.000Z";
const projectTitle = "真实采购运行项目";
const prompt = "为企业采购审批生成真实工作台";
const activityLabel = "正在分析真实采购流程";
const assistantMessage = "已读取真实采购规则，正在整理界面结构。";
const phaseLabel = "正在编排真实采购工作台";
const legacySyntheticCopy = [
  "产品工作台示例项目",
  "Assistant Active",
  "Initialize grid syst...",
  "Generate color tokens",
  "Synthesizing layout...",
  "Apply shader effects",
  "14:42:11",
  "14:42:15",
  "view_quilt Debug_Frame_v2: Frame",
  "Make it darker",
  "Add a hero",
  "Bento layout",
  "Debug Canvas",
  "Shader",
  "image placeholder",
  "image palette",
  "image dark",
  "image light",
  "Lumina Dark",
];
const outputDir = fileURLToPath(new URL("../../output/audit/1.0.0/browser-remediation/", import.meta.url));
const desktopScreenshot = path.join(outputDir, "workbench-run-preview-desktop-1501x855.png");
const mobileScreenshot = path.join(outputDir, "workbench-run-preview-mobile-390x844.png");
const unknownRequests = [];
const consoleErrors = [];
const streamCursors = [];
const boardSaveIdempotencyKeys = [];
const submissionIntentCreates = [];
const submissionIntentSubmits = [];
const currentSubmissionIntentReads = [];
let designPresetReads = 0;
let activeSubmissionIntent = null;
let runSubmitted = false;

const designPresetDefinition = {
  presetId: "workbench.alexandria",
  version: 1,
  label: "Alexandria",
  swatch: "#6f85ff",
  description: "A precise editorial product language with strong reading hierarchy and measured indigo emphasis.",
  directives: {
    composition: "Use a disciplined editorial grid, generous margins, and a clear primary reading column.",
    hierarchy: "Create hierarchy through scale, weight, and whitespace before introducing decorative treatment.",
    typography: "Pair authoritative serif-like display rhythm with highly legible neutral body typography.",
    components: "Keep controls restrained, information-dense, and aligned to an exact baseline and edge system.",
    imagery: "Use documentary or product-specific imagery with deliberate crops and concise supporting captions.",
    interaction: "Prefer quiet state transitions, explicit focus treatment, and stable layouts during updates.",
  },
  tokens: {
    colors: {
      canvas: "#f7f8fc",
      surface: "#ffffff",
      surfaceMuted: "#eef0f7",
      textPrimary: "#171925",
      textSecondary: "#5f6475",
      accent: "#6f85ff",
      accentContrast: "#ffffff",
      border: "#d8dbe7",
      focus: "#465ed6",
      danger: "#c73c52",
    },
    typography: {
      headingFamily: "Georgia, 'Times New Roman', serif",
      bodyFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      headingWeight: 600,
      bodyWeight: 400,
      baseSizePx: 16,
      lineHeight: 1.55,
    },
    geometry: { cornerRadiusPx: 4, controlRadiusPx: 4, borderWidthPx: 1, controlHeightPx: 40 },
    layout: { density: "balanced", spacingUnitPx: 8, contentMaxWidthPx: 1280, gridColumns: 12 },
    motion: { durationFastMs: 120, durationStandardMs: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  },
};
const designPreset = {
  ...designPresetDefinition,
  checksum: createHash("sha256").update(canonicalize(designPresetDefinition)).digest("hex"),
};
const designPresetReference = {
  kind: "preset",
  presetId: designPreset.presetId,
  version: designPreset.version,
  checksum: designPreset.checksum,
};

const project = {
  id: "project-run-preview",
  workspaceId: "workspace-1",
  title: projectTitle,
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const thread = {
  id: "thread-run-preview",
  projectId: project.id,
  title: "真实采购需求",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const promptEntry = {
  id: "entry-run-preview-prompt",
  threadId: thread.id,
  sequence: 1,
  role: "user",
  kind: "message",
  content: {
    protocol: "workbench.entry.v1",
    type: "user.prompt",
    text: prompt,
    sourceIds: [],
  },
  producedByRunId: null,
  createdAt: timestamp,
};

const run = {
  id: "run-preview-1",
  requestId: "request-run-preview-1",
  projectId: project.id,
  threadId: thread.id,
  retryOfRunId: null,
  status: "queued",
  modelId: "quality",
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: designPresetReference,
  artifactTargets: [],
  requestedArtifactKinds: [],
  sources: [],
  knowledgeReleaseId: null,
  phase: null,
  phaseLabel: null,
  progress: null,
  attempt: 0,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: timestamp,
  startedAt: null,
  finishedAt: null,
};

const prototypeArtifactId = "artifact-procurement";
const prototypeVersionId = "version-procurement-draft";
const prototypeDocument = prototypeDocumentFixture();
const prototypeChecksum = createHash("sha256")
  .update(canonicalize(prototypeDocument))
  .digest("hex");
const prototypeDraftScreens = prototypeDocument.screens.map((screen) => ({
  id: screen.id,
  name: screen.name,
  route: screen.route,
  viewport: screen.viewport,
  revision: 0,
  checksum: "e".repeat(64),
}));
const prototypeCheckpointScreens = prototypeDocument.screens.map((screen) => {
  const revision = 0;
  const projection = projectPrototypeScreen(prototypeDocument, screen.id, revision);
  const checksum = computePrototypeScreenProjectionChecksum(
    projection,
    (canonicalProjection) => createHash("sha256").update(canonicalProjection).digest("hex"),
  );
  return { screenId: screen.id, revision, checksum };
});

let board = {
  id: "board-run-preview",
  projectId: project.id,
  revision: 1,
  viewport: { x: -300, y: 43, zoom: 0.34 },
  nodes: [],
  edges: [],
};

const events = [
  runEvent(1, "run.started", { attempt: 1 }),
  runEvent(2, "run.phase.changed", {
    phase: "planning",
    label: phaseLabel,
    progress: 0.35,
  }),
  runEvent(3, "activity.changed", {
    activityId: "activity-real-procurement",
    status: "succeeded",
    label: activityLabel,
    detail: "正在核对审批角色、额度与流程约束。",
  }),
  runEvent(4, "activity.changed", {
    activityId: "activity-procurement-roles",
    status: "succeeded",
    label: "已确认采购审批角色",
    detail: "采购申请、部门审批与财务复核角色已确认。",
  }),
  runEvent(5, "activity.changed", {
    activityId: "activity-procurement-limits",
    status: "succeeded",
    label: "已建立采购额度规则",
    detail: "采购额度与升级审批规则已建立。",
  }),
  runEvent(6, "message.started", { entryId: "message-real-procurement" }),
  runEvent(7, "message.delta", {
    entryId: "message-real-procurement",
    delta: assistantMessage,
  }),
  runEvent(8, "run.generation.stage.changed", {
    attempt: 1,
    stage: "screen-streaming",
  }),
  runEvent(9, "artifact.draft.created", {
    attempt: 1,
    artifactIndex: 0,
    artifactId: prototypeArtifactId,
    artifactVersionId: prototypeVersionId,
    kind: "prototype",
    checksum: prototypeChecksum,
    draftChecksum: "d".repeat(64),
    screens: prototypeDraftScreens,
  }),
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1501, height: 855 } });
  await context.addCookies([{
    name: "workbench.session_token",
    value: "run-preview-session",
    url: origin,
  }]);

  await context.route("**/api/auth/**", async (route) => {
    await json(route, {
      session: {
        id: "session-run-preview",
        token: "run-preview-session",
        userId: "principal-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
        ipAddress: null,
        userAgent: "Playwright",
      },
      user: {
        id: "principal-1",
        name: "Run Preview Reviewer",
        email: "run-preview@example.test",
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
    const requestPath = url.pathname;
    const method = request.method();

    if (method === "GET" && requestPath === `/api/v1/runs/${run.id}/events`) {
      assert(runSubmitted, "Run events must not be requested before SubmissionIntent submit succeeds");
      const afterSequence = Number(url.searchParams.get("afterSequence") ?? "0");
      streamCursors.push(afterSequence);
      const pendingEvents = events.filter((event) => event.sequence > afterSequence);
      return sse(route, pendingEvents);
    }
    if (method === "GET" && requestPath === `/api/v1/runs/${run.id}`) {
      assert(runSubmitted, "Run must not be refreshed before SubmissionIntent submit succeeds");
      return json(route, run);
    }
    if (method === "GET" && requestPath === "/api/v1/identity/me") {
      return json(route, {
        id: "principal-1",
        issuer: "https://identity.example.test",
        subject: "run-preview-reviewer",
        email: "run-preview@example.test",
        displayName: "Run Preview Reviewer",
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
        id: "quality",
        displayName: "Quality model",
        description: null,
        supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
        supportsThinking: true,
        supportsReasoningEffort: false,
      }] });
    }
    if (method === "GET" && requestPath === "/api/v1/design-presets") {
      designPresetReads += 1;
      return json(route, { items: [designPreset] });
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
        entries: runSubmitted ? [promptEntry] : [],
        board,
        artifacts: [],
        latestRun: runSubmitted ? run : null,
      }, { etag: '"1"' });
    }
    if (method === "PUT" && requestPath === `/api/v1/projects/${project.id}/canvas-agent/state`) {
      const state = request.postDataJSON();
      return json(route, {
        protocol: "workbench.canvas-client-state.v1",
        activeSession: false,
        canvasStateRevision: state.canvasStateRevision,
      });
    }
    if (
      method === "GET"
      && requestPath === `/api/v1/threads/${thread.id}/submission-intents/current`
    ) {
      currentSubmissionIntentReads.push(activeSubmissionIntent?.id ?? null);
      return json(route, { item: activeSubmissionIntent });
    }
    if (
      method === "POST"
      && requestPath === `/api/v1/threads/${thread.id}/submission-intents`
    ) {
      assert(activeSubmissionIntent === null, "The Thread may have only one active SubmissionIntent");
      const idempotencyKey = request.headers()["idempotency-key"];
      assert(
        /^submission:[A-Za-z0-9_-]{24}$/u.test(idempotencyKey ?? ""),
        `SubmissionIntent create requires a caller-owned Idempotency-Key: ${idempotencyKey}`,
      );
      const body = request.postDataJSON();
      assert(body.request?.prompt === prompt, `Intent must preserve the prompt: ${JSON.stringify(body)}`);
      assert(body.request?.modelId === run.modelId, `Intent must preserve the model: ${JSON.stringify(body)}`);
      assert(body.request?.workflow === "generate", `Intent must use generate workflow: ${JSON.stringify(body)}`);
      assert(body.request?.targetSurface === "web", `Intent must preserve the Web target: ${JSON.stringify(body)}`);
      assert(
        JSON.stringify(body.request?.designStyle) === JSON.stringify(designPresetReference),
        `Intent must pin the server Design Preset reference: ${JSON.stringify(body)}`,
      );
      assert(
        JSON.stringify(body.request?.requestedArtifactKinds) === JSON.stringify(["prototype"]),
        `Generated mode must request exactly one Prototype artifact: ${JSON.stringify(body)}`,
      );
      assert(
        !Object.hasOwn(body.request ?? {}, "attachmentIds"),
        "SubmissionIntent Run request must not contain the legacy attachmentIds field",
      );
      assert(
        Array.isArray(body.attachments) && body.attachments.length === 0,
        `This attachment-free flow must create zero durable slots: ${JSON.stringify(body)}`,
      );
      activeSubmissionIntent = {
        id: "submission-intent-run-preview-1",
        projectId: project.id,
        threadId: thread.id,
        status: "pending",
        request: body.request,
        attachments: [],
        runId: null,
        lastFailure: null,
        revision: 1,
        submittedAt: null,
        cancelledAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      submissionIntentCreates.push({ idempotencyKey, request: body });
      return json(route, activeSubmissionIntent, {
        etag: '"1"',
        location: `/api/v1/submission-intents/${activeSubmissionIntent.id}`,
      }, 201);
    }
    if (
      method === "POST"
      && requestPath === `/api/v1/submission-intents/submission-intent-run-preview-1/submit`
    ) {
      assert(
        activeSubmissionIntent !== null,
        `SubmissionIntent must exist before submit (completed=${submissionIntentSubmits.length}, run=${JSON.stringify(run)})`,
      );
      assert(
        request.headers()["if-match"] === undefined
          && request.headers()["idempotency-key"] === undefined,
        "SubmissionIntent submit must use its persisted server idempotency key without client headers",
      );
      const submittedIntent = {
        ...activeSubmissionIntent,
        status: "submitted",
        runId: run.id,
        revision: 2,
        submittedAt: timestamp,
        updatedAt: timestamp,
      };
      const {
        prompt: _prompt,
        canvasSnapshot: _canvasSnapshot,
        sourceIds: _sourceIds,
        ...submittedRunRequest
      } = activeSubmissionIntent.request;
      Object.assign(run, submittedRunRequest);
      submissionIntentSubmits.push(activeSubmissionIntent.id);
      activeSubmissionIntent = null;
      runSubmitted = true;
      return json(route, { intent: submittedIntent, run }, {
        etag: '"2"',
        location: `/api/v1/runs/${run.id}`,
      }, 202);
    }
    if (method === "POST" && requestPath === `/api/v1/threads/${thread.id}/runs`) {
      throw new Error("Direct Run creation is forbidden; use SubmissionIntent create and submit");
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/board`) {
      return json(route, board, { etag: '"1"' });
    }
    if (
      method === "GET"
      && requestPath === `/api/v1/artifacts/${prototypeArtifactId}/versions/${prototypeVersionId}`
    ) {
      return json(route, {
        artifactId: prototypeArtifactId,
        artifactVersionId: prototypeVersionId,
        version: 1,
        kind: "prototype",
        schemaVersion: 1,
        status: "staging",
        checksum: prototypeChecksum,
        citations: [],
        createdByRunId: run.id,
        knowledgeReleaseId: null,
        createdAt: timestamp,
        contentMode: "inline",
        content: prototypeDocument,
      }, { etag: `"${prototypeChecksum}"` });
    }
    if (
      method === "GET"
      && requestPath === `/api/v1/runs/${run.id}/artifact-drafts/${prototypeVersionId}/checkpoint`
    ) {
      const requestedScreenId = url.searchParams.get("screenId");
      const screens = requestedScreenId === null
        ? prototypeCheckpointScreens
        : prototypeCheckpointScreens.filter((screen) => screen.screenId === requestedScreenId);
      if (requestedScreenId !== null && screens.length !== 1) {
        return json(route, {
          type: "about:blank",
          title: "Prototype patch checkpoint not found",
          status: 404,
          code: "PROTOTYPE_PATCH_CHECKPOINT_NOT_FOUND",
        }, {}, 404);
      }
      return json(route, {
        protocol: "workbench.prototype-patch-checkpoint.v1",
        projectId: project.id,
        runId: run.id,
        requestId: run.requestId,
        attempt: 1,
        runtimeAttemptId: "runtime-attempt-run-preview-1",
        artifactIndex: 0,
        artifactId: prototypeArtifactId,
        artifactVersionId: prototypeVersionId,
        status: "staging",
        document: prototypeDocument,
        documentChecksum: prototypeChecksum,
        screens,
        lastSequence: 9,
      });
    }
    if (method === "PUT" && requestPath === `/api/v1/projects/${project.id}/board`) {
      const expected = `"${board.revision}"`;
      assert(request.headers()["if-match"] === expected, `Expected If-Match ${expected}`);
      const idempotencyKey = request.headers()["idempotency-key"];
      assert(
        /^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey ?? ""),
        "Board save requires a valid Idempotency-Key",
      );
      assert(
        !boardSaveIdempotencyKeys.includes(idempotencyKey),
        "A new Board snapshot must use a fresh Idempotency-Key",
      );
      boardSaveIdempotencyKeys.push(idempotencyKey);
      board = {
        ...board,
        ...request.postDataJSON(),
        id: board.id,
        projectId: board.projectId,
        revision: board.revision + 1,
      };
      return json(route, board, { etag: `"${board.revision}"` });
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
    if (method === "GET" && requestPath === `/api/v1/runs/${run.id}/approvals`) {
      return json(route, { items: [] });
    }
    if (method === "GET" && requestPath === "/api/v1/exports/capabilities") {
      const unavailable = {
        available: false,
        authentication: "not_required",
        reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
      };
      return json(route, {
        formats: {
          html: unavailable,
          react: unavailable,
          figma: unavailable,
          mcp: unavailable,
          docx: unavailable,
          pdf: unavailable,
        },
        packaging: { single_file: unavailable, zip: unavailable },
        external: {
          ai_studio: unavailable,
          netlify: unavailable,
          lovable: unavailable,
          bolt: unavailable,
        },
      });
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
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`${origin}/projects/${encodeURIComponent(project.id)}`, { waitUntil: "domcontentloaded" });
  assert(await page.title() === "产品工作台", "browser title must use 产品工作台");
  await page.locator("[data-workbench-project]").waitFor();
  const composer = page.locator("[data-project-composer]");
  await composer.waitFor();
  await composer.getByRole("button", { name: "选择生成类型" }).click();
  await composer.getByRole("menuitemradio", { name: /生成原型/u }).click();
  await composer.getByRole("button", { name: "Web" }).click();
  await composer.getByRole("button", { name: "样式" }).click();
  const styleMenu = composer.getByRole("menu");
  await styleMenu.getByRole("menuitem", { name: designPreset.label }).waitFor();
  await styleMenu.getByRole("menuitem", { name: designPreset.label }).click();
  await composer.locator("input.workbench-composer-field").fill(prompt);
  await composer.getByRole("button", { name: "提交项目请求" }).click();
  await waitForValue(
    () => submissionIntentSubmits.length === 1,
    page,
    "SubmissionIntent submit",
  );
  const previewNode = page.locator(
    '[data-workbench-generated-node][data-generated-index="1"]',
  );
  try {
    await previewNode.waitFor({ timeout: 10_000 });
  } catch (error) {
    const pageState = await page.locator("body").innerText().catch(() => "<body unavailable>");
    throw new Error([
      "Run preview did not appear after SubmissionIntent submit",
      `unknownRequests=${JSON.stringify(unknownRequests)}`,
      `consoleErrors=${JSON.stringify(consoleErrors)}`,
      `currentSubmissionIntentReads=${JSON.stringify(currentSubmissionIntentReads)}`,
      `pageState=${JSON.stringify(pageState.slice(0, 4_000))}`,
    ].join("\n"), { cause: error });
  }
  const runSurface = page.locator("[data-workbench-project]");
  await previewNode.getByText("正在细化：采购审批页", { exact: true }).first().waitFor();
  await runSurface.getByText(prompt, { exact: true }).first().waitFor();
  await runSurface.getByText(activityLabel, { exact: true }).first().waitFor();
  await runSurface.getByText(assistantMessage, { exact: true }).first().waitFor();
  const phaseLabels = runSurface.getByText(phaseLabel, { exact: true });
  await phaseLabels.first().waitFor();

  assert(
    await runSurface.getByText(projectTitle, { exact: true }).count() >= 1,
    "Pending Board preview must show the real Project title",
  );
  assert(
    await phaseLabels.count() >= 1,
    "Pending Board preview must show the real Run phase label",
  );
  const logPanel = runSurface.locator("[data-left-task-stack]");
  const logHeader = logPanel.getByText("智能体日志", { exact: true });
  await logHeader.waitFor();
  const logRows = logPanel.locator("div.workbench-task-pill, button[aria-pressed]");
  const desktopLogRowCount = await logRows.count();
  assert(
    desktopLogRowCount === 4,
    `Pending Board preview must render exactly four Run log rows: ${desktopLogRowCount}`,
  );
  assert(
    await page.locator('[data-id*="synthetic"]').count() === 0,
    "Pending Board preview must not expose synthetic node ids",
  );
  for (const fakeCopy of legacySyntheticCopy) {
    assert(
      await page.getByText(fakeCopy, { exact: true }).count() === 0,
      `Legacy synthetic copy must be absent: ${fakeCopy}`,
    );
  }

  await assertNoHorizontalPageOverflow(page, "desktop");
  await page.screenshot({ path: desktopScreenshot, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await assertNoHorizontalPageOverflow(page, "390px mobile");
  assert(
    await runSurface.getByText(activityLabel, { exact: true }).count() >= 1,
    "Real Run activity must remain mounted at 390px",
  );
  assert(
    await runSurface.getByText(assistantMessage, { exact: true }).count() >= 1,
    "Real assistant message must remain mounted at 390px",
  );
  assert(await logRows.count() === 4, "Run log must remain four rows at 390px");
  await page.screenshot({ path: mobileScreenshot, fullPage: true });

  assert(streamCursors[0] === 0, `Run stream must start at sequence 0: ${streamCursors.join(", ")}`);
  assert(designPresetReads === 1, `Design Preset catalog must be loaded exactly once: ${designPresetReads}`);
  assert(
    submissionIntentCreates.length === 1,
    `Exactly one SubmissionIntent must be created: ${submissionIntentCreates.length}`,
  );
  assert(
    submissionIntentSubmits.length === 1,
    `Exactly one SubmissionIntent must be submitted: ${submissionIntentSubmits.length}`,
  );
  assert(
    currentSubmissionIntentReads.length >= 2,
    `Current SubmissionIntent must be read before and after submit: ${currentSubmissionIntentReads.length}`,
  );
  assert(unknownRequests.length === 0, `Unhandled API requests: ${unknownRequests.join(", ")}`);
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);

  console.log(JSON.stringify({
    evidenceLevel,
    mockedTransport: true,
    ok: true,
    projectTitle,
    prompt,
    activityLabel,
    assistantMessage,
    runLogRows: await logRows.count(),
    streamCursors,
    designPreset: designPresetReference,
    submissionIntentCreates: submissionIntentCreates.length,
    submissionIntentSubmits: submissionIntentSubmits.length,
    currentSubmissionIntentReads,
    screenshots: [
      "output/audit/1.0.0/browser-remediation/workbench-run-preview-desktop-1501x855.png",
      "output/audit/1.0.0/browser-remediation/workbench-run-preview-mobile-390x844.png",
    ],
  }, null, 2));
} finally {
  await browser.close();
}

function runEvent(sequence, type, payload) {
  return {
    protocol: "workbench.run.v1",
    id: `event-run-preview-${sequence}`,
    projectId: project.id,
    threadId: thread.id,
    runId: run.id,
    requestId: run.requestId,
    sequence,
    occurredAt: timestamp,
    traceId: "trace-run-preview",
    type,
    payload,
  };
}

function prototypeDocumentFixture() {
  const literal = (value) => ({ kind: "literal", value });
  const screens = [
    {
      id: "screen-request",
      name: "采购申请页",
      route: "/request",
      viewport: { width: 390, height: 844 },
    },
    {
      id: "screen-approval",
      name: "采购审批页",
      route: "/approval",
      viewport: { width: 390, height: 844 },
    },
  ];
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-procurement-draft",
    title: "企业采购审批",
    revision: 1,
    screens: screens.map((screen) => ({
      ...screen,
      rootNodeId: `frame-${screen.id}`,
      initialStateId: null,
    })),
    nodes: screens.map((screen) => ({
      id: `frame-${screen.id}`,
      screenId: screen.id,
      parentId: null,
      name: screen.name,
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(screen.viewport.width),
        height: literal(screen.viewport.height),
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
    })),
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

async function waitForValue(predicate, page, label) {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < 8_000) {
    await page.waitForTimeout(50);
  }
  assert(predicate(), `${label} did not reach the expected state`);
}

async function sse(route, streamEvents) {
  const body = [
    "retry: 10000\n\n",
    ...streamEvents.map((event) => (
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

async function assertNoHorizontalPageOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    scrollX: window.scrollX,
  }));
  assert(
    dimensions.documentScrollWidth <= dimensions.documentClientWidth
      && dimensions.bodyScrollWidth <= dimensions.documentClientWidth
      && dimensions.scrollX === 0,
    `${label} must not have horizontal page overflow: ${JSON.stringify(dimensions)}`,
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
