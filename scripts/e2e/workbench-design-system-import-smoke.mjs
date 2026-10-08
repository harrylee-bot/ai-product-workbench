import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const origin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const timestamp = "2026-07-15T03:00:00.000Z";
const sourceChecksum = "d".repeat(64);
const requestHash = "e".repeat(64);
const prompt = "生成采用采购品牌规范的 Web 门户";
const outputDir = fileURLToPath(new URL("../../output/audit/1.0.0/browser-remediation/", import.meta.url));
const screenshot = path.join(outputDir, "workbench-design-system-import-1501x855.png");
const unknownRequests = [];
const consoleErrors = [];
const lifecycle = [];
const bootstrapSnapshots = [];
const createdSubmissionIntentRequests = [];
const submittedIntentRunRequests = [];
const submittedSubmissionIntentIds = [];

const sourceCatalogItem = {
  projectId: "project-design-source",
  projectTitle: "采购品牌中心",
  artifactId: "artifact-design-source",
  artifactTitle: "采购品牌规范",
  artifactVersionId: "version-design-source-v3",
  version: 3,
  checksum: sourceChecksum,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const project = {
  id: "project-design-target",
  workspaceId: "workspace-1",
  title: prompt,
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const thread = {
  id: "thread-design-target",
  projectId: project.id,
  title: "项目需求",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

let board = {
  id: "board-design-target",
  projectId: project.id,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 0.6 },
  nodes: [],
  edges: [],
};
let importCompleted = false;
let activeSubmissionIntent = null;

const importedArtifact = {
  id: "artifact-design-imported",
  projectId: project.id,
  kind: "design_system",
  title: sourceCatalogItem.artifactTitle,
  revision: 1,
  currentVersion: {
    artifactId: "artifact-design-imported",
    artifactVersionId: "version-design-imported-v1",
    version: 1,
    kind: "design_system",
    schemaVersion: 1,
    status: "ready",
    checksum: sourceChecksum,
    createdByRunId: null,
    createdAt: timestamp,
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1501, height: 855 } });
  await context.addCookies([{
    name: "workbench.session_token",
    value: "design-system-import-session",
    url: origin,
  }]);

  await context.route("**/api/auth/**", async (route) => {
    await json(route, {
      session: {
        id: "session-design-system-import",
        token: "design-system-import-session",
        userId: "principal-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
        ipAddress: null,
        userAgent: "Playwright",
      },
      user: {
        id: "principal-1",
        name: "Design Reviewer",
        email: "design-reviewer@example.test",
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

    if (method === "GET" && requestPath === "/api/v1/identity/me") {
      return json(route, {
        id: "principal-1",
        issuer: "https://identity.example.test",
        subject: "design-reviewer",
        email: "design-reviewer@example.test",
        displayName: "Design Reviewer",
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
        id: "model-design-quality",
        displayName: "Design quality model",
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
        items: importCompleted ? [{ ...project, role: "owner", relationship: "owned" }] : [],
        nextCursor: null,
      });
    }
    if (method === "GET" && requestPath === "/api/v1/workspaces/workspace-1/design-systems") {
      return json(route, { items: [sourceCatalogItem], nextCursor: null });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/import-sources`) {
      return json(route, { items: [], nextCursor: null });
    }
    if (method === "POST" && requestPath === "/api/v1/workspaces/workspace-1/projects") {
      const body = request.postDataJSON();
      assert(body.title === prompt, `Created Project title must preserve the prompt: ${JSON.stringify(body)}`);
      lifecycle.push("project.created");
      return json(route, project, { etag: '"1"', location: `/api/v1/projects/${project.id}` }, 201);
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/bootstrap`) {
      lifecycle.push(importCompleted ? "bootstrap.after-import" : "bootstrap.before-import");
      const snapshot = bootstrapFixture();
      bootstrapSnapshots.push(snapshot);
      return json(route, snapshot, { etag: `"${board.revision}"` });
    }
    if (method === "GET" && requestPath === `/api/v1/threads/${thread.id}/submission-intents/current`) {
      return json(route, {
        item: activeSubmissionIntent?.status === "pending" ? activeSubmissionIntent : null,
      });
    }
    if (method === "POST" && requestPath === `/api/v1/projects/${project.id}/design-system-imports`) {
      assert(
        lifecycle.includes("bootstrap.before-import"),
        "The target Project bootstrap must be loaded before importing a Design System",
      );
      const body = request.postDataJSON();
      assert(
        body.sourceArtifactVersionId === sourceCatalogItem.artifactVersionId,
        `Import must use the selected immutable source version: ${JSON.stringify(body)}`,
      );
      const idempotencyKey = request.headers()["idempotency-key"];
      assert(
        /^design-system-import:[A-Za-z0-9_-]{8,}$/u.test(idempotencyKey ?? ""),
        `Import must use a stable caller-owned Idempotency-Key: ${idempotencyKey}`,
      );
      importCompleted = true;
      lifecycle.push("design-system.imported");
      return json(route, {
        id: "design-system-import-receipt-1",
        targetProjectId: project.id,
        targetArtifactId: importedArtifact.id,
        targetArtifactVersionId: importedArtifact.currentVersion.artifactVersionId,
        sourceProjectId: sourceCatalogItem.projectId,
        sourceArtifactId: sourceCatalogItem.artifactId,
        sourceArtifactVersionId: sourceCatalogItem.artifactVersionId,
        sourceChecksum,
        createdById: "principal-1",
        idempotencyKey,
        requestHash,
        createdAt: timestamp,
      }, {
        location: `/api/v1/artifacts/${importedArtifact.id}/versions/${importedArtifact.currentVersion.artifactVersionId}`,
      }, 201);
    }
    if (method === "POST" && requestPath === `/api/v1/threads/${thread.id}/submission-intents`) {
      assert(importCompleted, "A SubmissionIntent must not be created before the Design System import receipt exists");
      const idempotencyKey = request.headers()["idempotency-key"];
      assert(/^submission:[A-Za-z0-9_-]{8,}$/u.test(idempotencyKey ?? ""), "SubmissionIntent requires a caller-owned Idempotency-Key");
      const body = request.postDataJSON();
      assert(body.attachments?.length === 0, "Design System submission must persist an explicit empty attachment list");
      assert(
        body.request?.designStyle?.kind === "artifact"
          && body.request.designStyle.artifactVersionId === importedArtifact.currentVersion.artifactVersionId,
        `SubmissionIntent must pin the imported target Design System version: ${JSON.stringify(body)}`,
      );
      createdSubmissionIntentRequests.push(body);
      activeSubmissionIntent = pendingSubmissionIntentFixture(body);
      lifecycle.push("submission-intent.created");
      return json(route, activeSubmissionIntent, {
        etag: '"1"',
        location: "/api/v1/submission-intents/intent-design-import-1",
      }, 201);
    }
    if (method === "POST" && requestPath === "/api/v1/submission-intents/intent-design-import-1/submit") {
      assert(activeSubmissionIntent?.status === "pending", "Only the active pending SubmissionIntent may submit");
      const finalRequest = { ...activeSubmissionIntent.request, sourceIds: [] };
      submittedIntentRunRequests.push(finalRequest);
      submittedSubmissionIntentIds.push(activeSubmissionIntent.id);
      activeSubmissionIntent = submittedSubmissionIntentFixture(activeSubmissionIntent);
      lifecycle.push("submission-intent.submitted");
      lifecycle.push("run.started");
      return json(route, {
        intent: activeSubmissionIntent,
        run: runFixture(finalRequest),
      }, {
        etag: '"2"',
        location: "/api/v1/runs/run-design-import-1",
      }, 202);
    }
    if (method === "GET" && requestPath === "/api/v1/runs/run-design-import-1/events") {
      return sse(route);
    }
    if (method === "GET" && requestPath === "/api/v1/runs/run-design-import-1/approvals") {
      return json(route, { items: [] });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/board`) {
      return json(route, board, { etag: `"${board.revision}"` });
    }
    if (method === "PUT" && requestPath === `/api/v1/projects/${project.id}/board`) {
      const expected = `"${board.revision}"`;
      assert(request.headers()["if-match"] === expected, `Expected Board If-Match ${expected}`);
      board = {
        ...board,
        ...request.postDataJSON(),
        id: board.id,
        projectId: board.projectId,
        revision: board.revision + 1,
      };
      return json(route, board, { etag: `"${board.revision}"` });
    }
    if (method === "GET" && requestPath === `/api/v1/projects/${project.id}/members`) {
      return json(route, { items: [{
        projectId: project.id,
        principalId: "principal-1",
        role: "owner",
        displayName: "Design Reviewer",
        email: "design-reviewer@example.test",
        createdAt: timestamp,
        updatedAt: timestamp,
      }] });
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
    if (
      method === "GET"
      && requestPath === `/api/v1/artifacts/${importedArtifact.id}/versions/${importedArtifact.currentVersion.artifactVersionId}`
    ) {
      return json(route, {
        ...importedArtifact.currentVersion,
        citations: [],
        knowledgeReleaseId: null,
        contentMode: "inline",
        content: {
          protocol: "workbench.design-system.v1",
          documentId: "procurement-design-system",
          title: sourceCatalogItem.artifactTitle,
          tokens: [],
          assets: [],
          principles: [],
          guidelines: [],
          components: [],
        },
      }, { etag: `"${sourceChecksum}"` });
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

  await page.goto(origin, { waitUntil: "networkidle" });
  assert(await page.title() === "产品工作台", "browser title must use 产品工作台");
  await page.getByRole("heading", { name: /欢迎使用产品工作台/u }).waitFor();
  await page.getByRole("button", { name: "以您的设计为基础" }).click();
  const designMenu = page.getByRole("menu");
  await designMenu.waitFor();
  await designMenu.getByRole("menuitem", { name: /采购品牌规范/u }).click();
  await page.getByRole("button", { name: "样式: 采购品牌规范" }).waitFor();

  const composer = page.locator("[data-home-composer]");
  await composer.locator("textarea.workbench-composer-field").fill(prompt);
  await composer.locator("button.workbench-composer-send").click();

  await waitForValue(() => submittedIntentRunRequests.length === 1, page, "Design System SubmissionIntent submission");
  await page.waitForURL(`${origin}/projects/${project.id}`);
  await page.locator("[data-workbench-project]").waitFor();
  await page.screenshot({ path: screenshot, fullPage: true });

  const runRequest = submittedIntentRunRequests[0];
  assert(
    runRequest.designStyle?.kind === "artifact"
      && runRequest.designStyle.artifactVersionId === importedArtifact.currentVersion.artifactVersionId,
    `Run must pin the target import receipt version, not the source version: ${JSON.stringify(runRequest)}`,
  );
  assert(
    runRequest.designStyle.artifactVersionId !== sourceCatalogItem.artifactVersionId,
    "Run must never reference the cross-Project source Design System version directly",
  );
  assert(runRequest.targetSurface === "web", "Home target surface must be preserved in the Run request");
  assert(runRequest.prompt === prompt, "Home prompt must be preserved in the Run request");
  assert(
    lifecycle.indexOf("project.created") < lifecycle.indexOf("design-system.imported")
      && lifecycle.indexOf("design-system.imported") < lifecycle.indexOf("submission-intent.created")
      && lifecycle.indexOf("submission-intent.created") < lifecycle.indexOf("submission-intent.submitted")
      && lifecycle.indexOf("submission-intent.submitted") < lifecycle.indexOf("run.started"),
    `Project, import, SubmissionIntent and Run order is invalid: ${lifecycle.join(" -> ")}`,
  );
  assert(
    bootstrapSnapshots.some((snapshot) => snapshot.artifacts.length === 0)
      && bootstrapSnapshots.some((snapshot) => snapshot.artifacts.some(
        (artifact) => artifact.currentVersion?.artifactVersionId
          === importedArtifact.currentVersion.artifactVersionId,
      )),
    "Browser flow must observe both the pre-import and post-import target Project snapshots",
  );
  assert(unknownRequests.length === 0, `Unhandled API requests: ${unknownRequests.join(", ")}`);
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);
  assert(createdSubmissionIntentRequests.length === 1, "The imported Design System command must create one SubmissionIntent");
  assert(submittedSubmissionIntentIds.length === 1, "The imported Design System SubmissionIntent must submit exactly once");

  console.log(JSON.stringify({
    ok: true,
    lifecycle,
    sourceArtifactVersionId: sourceCatalogItem.artifactVersionId,
    targetArtifactVersionId: runRequest.designStyle.artifactVersionId,
    submissionIntentCreated: createdSubmissionIntentRequests.length,
    submissionIntentSubmitted: submittedSubmissionIntentIds.length,
    targetSurface: runRequest.targetSurface,
    screenshot: path.relative(fileURLToPath(new URL("../../", import.meta.url)), screenshot),
  }, null, 2));
} finally {
  await browser.close();
}

function bootstrapFixture() {
  return {
    project,
    access: { role: "owner" },
    threads: [thread],
    selectedThreadId: thread.id,
    entries: [],
    board,
    artifacts: importCompleted ? [importedArtifact] : [],
    latestRun: null,
  };
}

function runFixture(body) {
  return {
    id: "run-design-import-1",
    requestId: "request-design-import-1",
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
    sources: [],
    knowledgeReleaseId: null,
    phase: "publishing",
    phaseLabel: "设计系统已应用",
    progress: 1,
    attempt: 1,
    lastEventSequence: 1,
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
    id: "intent-design-import-1",
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
}

function submittedSubmissionIntentFixture(intent) {
  return {
    ...intent,
    status: "submitted",
    runId: "run-design-import-1",
    revision: 2,
    submittedAt: timestamp,
    updatedAt: timestamp,
  };
}

async function waitForValue(predicate, page, label) {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < 8_000) {
    await page.waitForTimeout(50);
  }
  assert(predicate(), `${label} did not reach the expected state`);
}

async function json(route, body, headers = {}, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    headers,
    body: JSON.stringify(body),
  });
}

async function sse(route) {
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: {
      "cache-control": "no-cache, no-store",
      "x-content-type-options": "nosniff",
    },
    body: "retry: 10000\n\n",
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
