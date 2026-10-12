import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson, createArtifactVersionRequestSchema } from "@workbench/workbench-contracts";
import { strToU8, zipSync } from "fflate";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { createDeliveryClient, deliverySmokeConfig, executeDeliveryHttpSmoke, submitDeliveryFromHome,
  verifyDeliveryPrototypeInteractions } from "./workbench-delivery-http-smoke.mjs";

const secret = "session-must-never-leak";
const token = "wbs_capability_must_never_leak";
const base = {
  WORKBENCH_DELIVERY_SMOKE_CONFIRM_WRITE: "CREATE_ISOLATED_DELIVERY_SMOKE_PROJECT",
  WORKBENCH_DELIVERY_SMOKE_BASE_URL: "https://workbench.example.test",
  WORKBENCH_DELIVERY_SMOKE_PREVIEW_ORIGIN: "https://preview.example.test",
  WORKBENCH_DELIVERY_SMOKE_SESSION_COOKIE: `session=${secret}`,
};

test("requires explicit execution setting before any authenticated request or mutation", async () => {
  let called = false;
  const result = await executeDeliveryHttpSmoke({ env: {}, fetchImpl: async () => { called = true; } });
  assert.equal(result.evidence.failureCode, "WRITE_CONFIRMATION_REQUIRED");
  assert.equal(called, false);
});

test("credential file must be outside source and owned with mode 0600", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "delivery-private-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "credentials.json");
  writeFileSync(filename, JSON.stringify({ BASE_URL: base.WORKBENCH_DELIVERY_SMOKE_BASE_URL,
    PREVIEW_ORIGIN: base.WORKBENCH_DELIVERY_SMOKE_PREVIEW_ORIGIN, SESSION_COOKIE: `session=${secret}` }), { mode: 0o600 });
  const env = { WORKBENCH_DELIVERY_SMOKE_CONFIRM_WRITE: base.WORKBENCH_DELIVERY_SMOKE_CONFIRM_WRITE,
    WORKBENCH_DELIVERY_SMOKE_CONFIG_FILE: filename };
  assert.equal(deliverySmokeConfig(env).cookie, `session=${secret}`);
  chmodSync(filename, 0o644);
  assert.throws(() => deliverySmokeConfig(env), { code: "PRIVATE_CONFIG_PERMISSIONS_INVALID" });
  assert.throws(() => deliverySmokeConfig({ ...env, WORKBENCH_DELIVERY_SMOKE_CONFIG_FILE: new URL(import.meta.url).pathname }),
    { code: "PRIVATE_CONFIG_MUST_BE_OUTSIDE_REPOSITORY" });
});

test("capability requests never forward cookies and reject untrusted preview origins", async () => {
  const calls = [];
  const client = createDeliveryClient(deliverySmokeConfig(base), async (url, options) => {
    calls.push({ url, options }); return new Response("ok");
  });
  await client.request(`/api/v1/public/shares/${token}`, { anonymous: true });
  await client.request(`https://preview.example.test/preview/${token}`, { anonymous: true, preview: true });
  assert.ok(calls.every(({ options }) => !options.headers.has("Cookie") && options.redirect === "manual"));
  await assert.rejects(client.request(`https://evil.example.test/preview/${token}`, { anonymous: true, preview: true }), { code: "REQUEST_ORIGIN_INVALID" });
  await assert.rejects(client.request(`https://preview.example.test/preview/${token}`, { preview: true }), { code: "PREVIEW_MUST_BE_ANONYMOUS" });
  assert.equal(calls.length, 2);
});

test("preview origin cannot equal the authenticated application origin", () => {
  assert.throws(() => deliverySmokeConfig({ ...base, WORKBENCH_DELIVERY_SMOKE_PREVIEW_ORIGIN: base.WORKBENCH_DELIVERY_SMOKE_BASE_URL }),
    { code: "PREVIEW_ORIGIN_MUST_BE_ISOLATED" });
});

test("full joint generation validates pinned citations, downloaded bytes, anonymous rendering, revocation and scoped cleanup", async () => {
  const fake = fixture();
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, true, JSON.stringify(result.evidence));
  assert.deepEqual(fake.requestedKinds, ["prd", "prototype"]);
  assert.equal(result.evidence.cleanup, "project-archived-shares-revoked");
  assert.equal(fake.archived, true);
  assert.equal(fake.browserCalls.share, 1);
  assert.equal(fake.browserCalls.document, 1);
  assert.equal(fake.browserCalls.revoked, 1);
  assert.equal(fake.browserCalls.closed, 1);
  assert.equal(fake.browserCalls.submit, 1);
  assert.equal(result.evidence.sessionCleanup, "signed-out");
  assert.equal(fake.signedOut, true);
  assert.ok(result.evidence.checks.some((check) => check.name === "anonymous-prototype-navigation-and-toggle-verified"));
  assert.equal(result.evidence.checks.filter((check) => check.name.endsWith("download-verified")).length, 3);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes("SECRET_KNOWLEDGE_QUOTE"));
});

test("lost submit response recovers and cancels only the run created in the isolated project", async () => {
  const fake = fixture({ lostSubmit: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failureCode, "HTTP_REQUEST_FAILED");
  assert.equal(result.evidence.cleanup, "project-archived-shares-revoked");
  assert.equal(fake.cancelled, true);
  assert.equal(fake.archived, true);
});

test("email login injects the returned session without retaining credentials in evidence", async () => {
  const fake = fixture();
  const env = { ...base, WORKBENCH_DELIVERY_SMOKE_SESSION_COOKIE: "", WORKBENCH_DELIVERY_SMOKE_EMAIL: "smoke@example.test",
    WORKBENCH_DELIVERY_SMOKE_PASSWORD: "private-password-never-logged" };
  const result = await executeDeliveryHttpSmoke({ env, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, true, JSON.stringify(result.evidence));
  assert.equal(fake.authenticated, true);
  assert.ok(!JSON.stringify(result).includes("smoke@example.test"));
  assert.ok(!JSON.stringify(result).includes("private-password-never-logged"));
});

test("lost project-create response recovers only its exact unique title and ownership", async () => {
  const fake = fixture({ lostProjectCreate: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.cleanup, "project-archived-shares-revoked");
  assert.equal(fake.archived, true);
});

test("successful run with missing prototype citations does not pass knowledge acceptance", async () => {
  const fake = fixture({ missingPrototypeCitations: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failureCode, "KNOWLEDGE_CITATIONS_MISSING");
  assert.equal(fake.archived, true);
});

test("corrupt document download fails and still removes the test project from active use", async () => {
  const fake = fixture({ corruptDownload: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failureCode, "EXPORT_BYTES_INVALID");
  assert.equal(fake.archived, true);
});

test("cleanup failures are visible and cannot result in a successful acceptance report", async () => {
  const fake = fixture({ archiveFailure: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.cleanup, "incomplete");
  assert.deepEqual(result.evidence.cleanupFailures, ["archive-project"]);
});

test("export with correct checksum but stale unedited content fails document acceptance", async () => {
  const fake = fixture({ staleDocumentDownload: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failureCode, "EXPORTED_DOCUMENT_EDIT_MISSING");
  assert.equal(fake.archived, true);
});

test("failed browser interaction still archives its project and signs out", async () => {
  const fake = fixture({ interactionFailure: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failureCode, "PROTOTYPE_NAVIGATION_INERT");
  assert.equal(fake.archived, true);
  assert.equal(fake.signedOut, true);
});

test("a session that remains usable after logout cannot pass acceptance", async () => {
  const fake = fixture({ logoutFailure: true });
  const result = await executeDeliveryHttpSmoke({ env: base, fetchImpl: fake.fetch, browserFactory: fake.browserFactory, pdfTools: fake.pdfTools });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.sessionCleanup, "failed");
  assert.equal(result.evidence.sessionCleanupFailure, "SESSION_STILL_ACTIVE");
  assert.equal(fake.archived, true);
});

function fixture({ lostSubmit = false, lostProjectCreate = false, corruptDownload = false, archiveFailure = false,
  missingPrototypeCitations = false, staleDocumentDownload = false, interactionFailure = false, logoutFailure = false } = {}) {
  const prd = structuredClone(prdDocumentV2Example);
  const prototype = JSON.parse(readFileSync(new URL("../integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json", import.meta.url), "utf8")).artifacts[0].content;
  const citation = { id: "citation-one", documentId: "document-one", chunkId: "chunk-one", sourcePath: "rules/example.md",
    title: "Example", quote: "SECRET_KNOWLEDGE_QUOTE", locator: { heading: "Example", startLine: 1, endLine: 2 } };
  prd.citations = [citation];
  const contents = { prd, prototype };
  const versions = Object.fromEntries(Object.entries(contents).map(([kind, content]) => [kind, {
    artifactId: `artifact-${kind}`, artifactVersionId: `version-${kind}`, kind, schemaVersion: kind === "prd" ? 2 : 1,
    status: "ready", version: 1, checksum: hash(canonicalJson(content)), citations: [citation],
    contentMode: "inline", content, createdByRunId: "run-own", knowledgeReleaseId: "knowledge-release", createdAt: "2026-10-12T00:00:00.000Z",
  }]));
  if (missingPrototypeCitations) versions.prototype.citations = [];
  const artifacts = Object.values(versions).map((version) => ({ id: version.artifactId, kind: version.kind, currentVersion: version }));
  const project = { id: "project-own", workspaceId: "workspace", revision: 1 };
  const board = { id: "board-own", revision: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const run = { id: "run-own", projectId: project.id, threadId: "thread-own", status: lostSubmit ? "running" : "succeeded",
    knowledgeReleaseId: "knowledge-release", requestedArtifactKinds: ["prd", "prototype"] };
  const release = { id: "release-own", projectId: project.id, status: "ready", artifactPins: [], boardSnapshot: board };
  const state = { archived: false, cancelled: false, submitted: false, revoked: false, browserCalls: { submit: 0, document: 0, share: 0, revoked: 0, closed: 0 } };
  let savedVersion;
  const jobs = new Map();
  const bytes = { docx: Buffer.from(`PK${"docx-body".repeat(25)}`), pdf: Buffer.from(`%PDF-${"pdf-body".repeat(25)}`), html: Buffer.from(`<html><body>${"preview".repeat(30)}</body></html>`) };
  const mime = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf", html: "text/html" };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  state.pdfTools = { check() {}, text: (value) => value.toString("utf8") };
  state.browserFactory = async (config) => ({
    submitFromHome: async ({ cookie, prompt, projectTitle, workspaceId, onCreateAttempt, onProject, onInitial }) => {
      state.browserCalls.submit++;
      assert.match(prompt, /这是隔离验收项目/u);
      assert.ok(projectTitle.includes(prompt.split("\n")[0]));
      const browserClient = createDeliveryClient({ ...config, cookie }, state.fetch);
      onCreateAttempt();
      onProject(await browserClient.json(`/api/v1/workspaces/${workspaceId}/projects`, { method: "POST", body: { title: projectTitle }, statuses: [201] }));
      const initial = await browserClient.json(`/api/v1/projects/${project.id}/bootstrap`);
      onInitial(initial);
      const intent = await browserClient.json(`/api/v1/threads/${initial.threads[0].id}/submission-intents`, { method: "POST",
        body: { request: { prompt, requestedArtifactKinds: ["prd", "prototype"] } }, statuses: [201] });
      return browserClient.json(`/api/v1/submission-intents/${intent.id}/submit`, { method: "POST", statuses: [202] });
    },
    verifyDocument: async ({ marker, cookie, nodeId }) => {
      assert.equal(cookie, `session=${secret}`); assert.equal(nodeId, "node-prd");
      assert.equal(savedVersion.content.versionHistory[0].author, marker); state.browserCalls.document++;
    },
    verifyShare: async (url) => {
      assert.ok(url.endsWith(token)); state.browserCalls.share++;
      if (interactionFailure) throw Object.assign(new Error("navigation failed"), { code: "PROTOTYPE_NAVIGATION_INERT" });
      return { navigationCount: 2, toggleCount: 2 };
    },
    verifyRevoked: async () => { assert.equal(state.revoked, true); state.browserCalls.revoked++; },
    close: async () => { state.browserCalls.closed++; },
  });
  state.fetch = async (url, options) => {
    const route = url.pathname;
    const method = options.method;
    const body = options.body ? JSON.parse(options.body) : null;
    const anonymous = route.startsWith("/api/v1/public/") || url.hostname === "preview.example.test" || route === "/api/auth/sign-in/email";
    assert.equal(options.headers.get("Cookie"), anonymous ? null : `session=${secret}`);
    if (!["GET", "HEAD"].includes(method)) assert.equal(options.headers.get("Origin"), base.WORKBENCH_DELIVERY_SMOKE_BASE_URL);
    if (route === "/api/auth/sign-in/email") {
      assert.equal(body.email, "smoke@example.test"); assert.equal(body.password, "private-password-never-logged");
      state.authenticated = true;
      return new Response("{}", { headers: { "set-cookie": `session=${secret}; Secure; HttpOnly; Path=/` } });
    }
    if (route === "/api/auth/sign-out") { state.signedOut = true; return json({ success: true }); }
    if (route === "/api/auth/get-session") return json(logoutFailure ? { session: { id: "still-active" } } : null);
    if (route === "/api/v1/identity/me") return json({ id: "principal", defaultWorkspaceId: "workspace" });
    if (route === "/api/v1/runtime/models") return json({ items: [{ id: "provider/model.v1", supportedWorkflows: ["generate"] }] });
    if (route === "/api/v1/exports/capabilities") return json({ formats: Object.fromEntries(["docx", "pdf", "html"].map((key) => [key, { available: true }])) });
    if (route === "/api/v1/workspaces/workspace/projects") {
      project.title = body.title;
      if (lostProjectCreate) throw new Error("lost-create-response");
      return json(project, 201);
    }
    if (route === "/api/v1/projects") {
      assert.equal(url.searchParams.get("q"), project.title);
      return json({ items: [{ ...project, workspaceId: "workspace", role: "owner", relationship: "owned" },
        { ...project, id: "project-other", role: "editor", relationship: "shared" }], nextCursor: null });
    }
    if (route === "/api/v1/projects/project-own/bootstrap") return json({ project, threads: [{ id: "thread-own" }], board, artifacts: state.submitted ? artifacts : [], latestRun: state.submitted ? run : null });
    if (route === "/api/v1/threads/thread-own/submission-intents") { state.requestedKinds = body.request.requestedArtifactKinds; return json({ id: "intent-own" }, 201); }
    if (route === "/api/v1/submission-intents/intent-own/submit") {
      state.submitted = true;
      board.nodes = ["prd", "prototype"].map((kind) => ({ id: `node-${kind}`, artifactId: `artifact-${kind}`, artifactVersionId: `version-${kind}` }));
      if (lostSubmit) throw new Error(`do-not-log-${secret}`); return json({ run }, 202);
    }
    if (route === "/api/v1/runs/run-own") return json(run);
    if (route === "/api/v1/runs/run-own/cancel") {
      assert.ok(options.headers.has("Idempotency-Key")); state.cancelled = true; run.status = "cancelled"; return json(run, 202);
    }
    for (const kind of ["prd", "prototype"]) if (route === `/api/v1/artifacts/artifact-${kind}/versions/version-${kind}`) return json(versions[kind]);
    if (route === "/api/v1/artifacts/artifact-prd") return json({ ...artifacts[0], projectId: project.id, revision: savedVersion ? 2 : 1 });
    if (route === "/api/v1/artifacts/artifact-prd/versions") {
      const request = createArtifactVersionRequestSchema.parse(body);
      assert.equal(options.headers.get("If-Match"), '"1"');
      assert.ok(options.headers.has("Idempotency-Key"));
      assert.equal(request.baseArtifactVersionId, "version-prd");
      assert.equal(request.document.revision.number, prd.revision.number + 1);
      savedVersion = { ...versions.prd, version: 2, artifactVersionId: "version-prd-edited", createdByRunId: null,
        content: request.document, checksum: hash(canonicalJson(request.document)) };
      artifacts[0].currentVersion = savedVersion;
      return json(savedVersion, 201);
    }
    if (route === "/api/v1/projects/project-own/board") {
      if (method === "PUT") {
        assert.equal(options.headers.get("If-Match"), '"1"');
        assert.equal(body.nodes[0].artifactVersionId, "version-prd-edited");
        Object.assign(board, body, { revision: 2 });
      }
      return json(board);
    }
    if (route === "/api/v1/projects/project-own/releases") {
      assert.equal(options.headers.get("If-Match"), '"2"');
      release.artifactPins = artifacts.map((item) => ({ kind: item.kind, artifactId: item.id, artifactVersionId: item.currentVersion.artifactVersionId }));
      return json(release, 201);
    }
    if (route === "/api/v1/releases/release-own") return json(release);
    if (route === "/api/v1/projects/project-own/exports") {
      if (method === "GET") return json({ items: [...jobs.values()], nextCursor: null });
      const format = body.format;
      const editMarker = staleDocumentDownload ? "original-unedited-author" : savedVersion.content.versionHistory[0].author;
      bytes.docx = Buffer.from(zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${editMarker}</w:t></w:r></w:p></w:body></w:document>`) }));
      bytes.pdf = Buffer.from(`%PDF-${"pdf-body".repeat(25)} ${editMarker}`);
      const job = { id: `export-${format}`, format, releaseId: release.id, status: "succeeded", revision: 1,
        selection: body.selection, output: { byteSize: bytes[format].length, sha256: hash(bytes[format]) } };
      jobs.set(job.id, job); return json(job, 202);
    }
    if (/^\/api\/v1\/exports\/export-(docx|pdf|html)$/u.test(route)) return json(jobs.get(route.split("/").at(-1)));
    if (/^\/api\/v1\/exports\/export-(docx|pdf|html)\/content$/u.test(route)) {
      const format = route.split("/").at(-2).slice(7);
      return new Response(corruptDownload ? "corrupted" : bytes[format], { headers: { "content-type": mime[format] } });
    }
    if (route === "/api/v1/exports/export-html/preview-token") return json({ url: `https://preview.example.test/preview/${token}` });
    if (route === `/preview/${token}`) return new Response(bytes.html, { headers: { "content-type": "text/html" } });
    if (route === "/api/v1/projects/project-own/shares/rotate") return json({ token }, 201);
    if (route === "/api/v1/projects/project-own/shares/revoke-all") { state.revoked = true; return json({ activeGrantCount: 0 }); }
    if (route === `/api/v1/public/shares/${token}`) return state.revoked ? json({}, 404)
      : json({ scope: "view", release: { ...release, artifactPins: release.artifactPins.filter((pin) => pin.kind === "prototype") } });
    if (route === `/api/v1/public/shares/${token}/artifacts/artifact-prd/versions/version-prd-edited`) return json({}, 404);
    for (const kind of ["prd", "prototype"]) if (route === `/api/v1/public/shares/${token}/artifacts/artifact-${kind}/versions/version-${kind}`) {
      const { createdByRunId: _runId, knowledgeReleaseId: _knowledgeReleaseId, ...publicVersion } = versions[kind];
      return state.revoked ? json({}, 404) : json({ ...publicVersion, citations: [] });
    }
    if (route === "/api/v1/projects/project-own" && method === "DELETE") {
      assert.equal(options.headers.get("If-Match"), '"1"');
      if (archiveFailure) return json({ message: secret }, 409);
      state.archived = true; return json({ ...project, status: "archived" });
    }
    assert.fail(`Unexpected mock route: ${method} ${route}`);
  };
  return state;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

// These are verifier regressions in a real browser, not substitutes for production/model acceptance.
test("browser verifier observes real home input and rejects broken generated controls", async (t) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const scenario of [
    { name: "arbitrary generated names support a persistent toggle and round-trip navigation" },
    { name: "static checkbox is rejected", inertToggle: true, code: "PROTOTYPE_TOGGLE_INERT" },
    { name: "inert navigation button is rejected", inertNavigation: true, code: "PROTOTYPE_NAVIGATION_INERT" },
    { name: "state lost across navigation is rejected", forgetState: true, code: "PROTOTYPE_TOGGLE_STATE_LOST" },
    { name: "external-effect buttons are never clicked", externalAction: true, code: "PROTOTYPE_NAVIGATION_MISSING" },
    { name: "a bubbling external action on a parent is never clicked", externalParent: true, code: "PROTOTYPE_NAVIGATION_MISSING" },
  ]) await t.test(scenario.name, async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(1_000);
    try {
      await page.setContent('<main><div data-canvas-visual-screen data-canvas-screen-id="screen-arbitrary-a"></div></main>');
      await page.evaluate(({ inertToggle, inertNavigation, forgetState }) => {
        const screen = document.querySelector("[data-canvas-visual-screen]");
        let checked = false;
        function render(screenId) {
          screen.setAttribute("data-canvas-screen-id", screenId);
          screen.replaceChildren();
          if (screenId === "screen-arbitrary-a") {
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.setAttribute("aria-label", "任意生成的通知选项");
            checkbox.checked = checked;
            checkbox.onclick = (event) => { if (inertToggle) event.preventDefault(); else checked = checkbox.checked; };
            screen.append(checkbox);
          }
          const button = document.createElement("button");
          button.textContent = screenId === "screen-arbitrary-a" ? "查看接收日志" : "调整告知偏好";
          button.onclick = () => {
            if (inertNavigation) return;
            if (forgetState) checked = false;
            render(screenId === "screen-arbitrary-a" ? "screen-arbitrary-b" : "screen-arbitrary-a");
          };
          screen.append(button);
        }
        render("screen-arbitrary-a");
      }, scenario);
      const document = {
        screens: [{ id: "screen-arbitrary-a" }, { id: "screen-arbitrary-b" }],
        nodes: [
          { id: "toggle-x", screenId: "screen-arbitrary-a", kind: "input", inputType: "checkbox", label: "任意生成的通知选项", actionIds: [], bindingIds: ["value-x"] },
          { id: "next-x", screenId: "screen-arbitrary-a", kind: "button", label: "查看接收日志", actionIds: ["next-action"], bindingIds: [] },
          { id: "back-x", screenId: "screen-arbitrary-b", kind: "button", label: "调整告知偏好", actionIds: ["back-action"], bindingIds: [] },
        ],
        bindings: [{ id: "value-x", nodeId: "toggle-x", property: "value", source: { kind: "variable", path: "notifications.enabled" } }],
        actions: [
          { id: "next-action", nodeId: "next-x", event: "click", kind: scenario.externalAction ? "openUrl" : "navigate", targetScreenId: "screen-arbitrary-b" },
          { id: "back-action", nodeId: "back-x", event: "press", kind: "navigate", targetScreenId: "screen-arbitrary-a" },
        ],
      };
      if (scenario.externalParent) {
        document.nodes[1].parentId = "unsafe-parent";
        document.nodes.push({ id: "unsafe-parent", kind: "frame", screenId: "screen-arbitrary-a", parentId: null, actionIds: ["external-parent-action"], bindingIds: [] });
        document.actions.push({ id: "external-parent-action", nodeId: "unsafe-parent", event: "click", kind: "openUrl" });
      }
      const result = verifyDeliveryPrototypeInteractions(page, document, { timeoutMs: 180 });
      if (scenario.code) await assert.rejects(result, { code: scenario.code });
      else {
        assert.deepEqual(await result, { navigationCount: 2, toggleCount: 2 });
        assert.equal(await page.getByRole("checkbox").isChecked(), false);
      }
      if (scenario.externalAction || scenario.externalParent) assert.equal(await page.locator("[data-canvas-visual-screen]").getAttribute("data-canvas-screen-id"), "screen-arbitrary-a");
    } finally { await page.close(); }
  });

  for (const wrongKinds of [false, true]) await t.test(wrongKinds
    ? "home request that omits one artifact kind is rejected"
    : "home text entry, output selection and click are observed through actual HTTP responses", async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(2_000);
    const submittedPrompt = "[SMOKE] 1.0.0 local-verifier-only\n请生成中文需求文档和原型";
    const projectTitle = submittedPrompt.replace(/\s+/gu, " ");
    const observed = [];
    const project = { id: "browser-project", workspaceId: "workspace", title: projectTitle };
    const initial = { project, threads: [{ id: "browser-thread" }], artifacts: [], board: { nodes: [] } };
    await page.route("https://workbench.example.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/") {
        const script = `document.querySelector('[aria-label="选择生成类型"]').onclick = () => { document.querySelector('[role="menuitemradio"]').hidden = false; };
document.querySelector('[role="menuitemradio"]').onclick = () => { document.querySelector('[role="menuitemradio"]').hidden = true; };
document.querySelector('[aria-label="提交提示"]').onclick = async () => {
  const prompt = document.querySelector('textarea').value;
  const request = { prompt, modelId: 'model-browser', workflow: 'generate', targetSurface: 'web', sourceIds: [], artifactTargets: [], requestedArtifactKinds: ${JSON.stringify(wrongKinds ? ["prd"] : ["prd", "prototype"])} };
  await fetch('/api/v1/workspaces/workspace/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: prompt.replace(/\\s+/g, ' ') }) });
  await fetch('/api/v1/projects/browser-project/bootstrap');
  await fetch('/api/v1/threads/browser-thread/submission-intents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request, attachments: [] }) });
  await fetch('/api/v1/submission-intents/browser-intent/submit', { method: 'POST' });
};`;
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<textarea aria-label="提示词"></textarea><button aria-label="选择生成类型">类型</button><button role="menuitemradio" hidden>需求文档＋原型 生成关联的文档与可交互原型</button><button aria-label="提交提示">发送</button><script>' + script + '</script>' });
      }
      observed.push(pathname);
      const [value, status] = pathname.endsWith("/projects") ? [project, 201]
        : pathname.endsWith("/bootstrap") ? [initial, 200]
          : pathname.endsWith("/submission-intents") ? [{ id: "browser-intent" }, 201]
            : [{ run: { id: "browser-run", projectId: project.id, threadId: "browser-thread" } }, 202];
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    });
    try {
      const result = submitDeliveryFromHome(page, { baseUrl: base.WORKBENCH_DELIVERY_SMOKE_BASE_URL,
        prompt: submittedPrompt, projectTitle, workspaceId: "workspace", modelIds: ["model-browser"],
        onCreateAttempt: () => observed.push("attempt"),
        onProject: (value) => assert.deepEqual(value, project),
        onInitial: (value) => assert.deepEqual(value, initial),
      });
      if (wrongKinds) await assert.rejects(result, { code: "BROWSER_SUBMISSION_REQUEST_INVALID" });
      else {
        assert.equal((await result).run.id, "browser-run");
        assert.equal(await page.getByRole("textbox", { name: "提示词" }).inputValue(), submittedPrompt);
        assert.equal(observed.length, 5);
      }
    } finally { await page.close(); }
  });
});
