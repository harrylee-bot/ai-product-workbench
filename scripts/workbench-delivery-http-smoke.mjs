#!/usr/bin/env node

// Final, isolated 1.0.0 acceptance. Never import production secrets into source or logs.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { artifactVersionDetailSchema, canonicalJson } from "@workbench/workbench-contracts";
import { unzipSync } from "fflate";
import { assertPrdV2Structure } from "./workbench-prd-http-smoke.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const terminal = new Set(["succeeded", "failed", "cancelled"]);
const confirmation = "CREATE_ISOLATED_DELIVERY_SMOKE_PROJECT";
const prompt = [
  "这是隔离验收项目，无需追问。请基于项目知识库中的需求模板、渠道与安全规范，同时生成一份完整中文需求说明书和一份可交互网页原型。",
  "业务主题：已登录消费者的电商订单通知设置。需要通知开关、订单状态分类、发送结果记录、失败重试、权限反馈及完整性和一致性校验。",
  "通知开关沿用消费者现有设置，不新增默认状态；订单状态分类沿用订单中心既有分类，不新增或枚举分类。仅端内渠道启用，不投放 WAP/H5 或小程序。",
  "先检索知识库并引用实际命中的资料，产物保留可追溯引用，不编造来源。PRD 使用 workbench.prd.v2，prototype 使用当前原型协议；原型包含设置页、记录页和可操作的切换或导航。",
  "原型首屏为设置页，通知开关必须使用带可访问名称的原生 checkbox，并通过 value binding 绑定布尔变量；保持用户当前值，不通过跳页重置。设置页和记录页各有带固定中文名称的按钮，通过 navigate action 双向跳转。不要用外链、静态图片或装饰文字代替控件。",
  "按以上明确前提一次完成两种产物，不向外部服务发布，不发送消息。",
].join("\n");

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const ensure = (condition, code) => { if (!condition) fail(code); };
const safeCode = (error) => /^[A-Z][A-Z0-9_]{1,100}$/u.test(error?.code) ? error.code : "SMOKE_FAILED";
const id = (value) => { ensure(typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/u.test(value), "RESPONSE_ID_INVALID"); return value; };
const enc = (value) => encodeURIComponent(id(value));
const etag = (value) => { ensure(Number.isSafeInteger(value) && value >= 0, "REVISION_INVALID"); return `"${value}"`; };

export function deliverySmokeConfig(env) {
  ensure(env.WORKBENCH_DELIVERY_SMOKE_CONFIRM_WRITE === confirmation, "WRITE_CONFIRMATION_REQUIRED");
  let privateValues = {};
  if (env.WORKBENCH_DELIVERY_SMOKE_CONFIG_FILE) {
    const filename = realpathSync(env.WORKBENCH_DELIVERY_SMOKE_CONFIG_FILE);
    const metadata = lstatSync(filename);
    ensure(!filename.startsWith(`${repository}${path.sep}`) && filename !== repository, "PRIVATE_CONFIG_MUST_BE_OUTSIDE_REPOSITORY");
    ensure(metadata.isFile() && (metadata.mode & 0o777) === 0o600
      && (typeof process.getuid !== "function" || metadata.uid === process.getuid()), "PRIVATE_CONFIG_PERMISSIONS_INVALID");
    privateValues = JSON.parse(readFileSync(filename, "utf8"));
  }
  const value = (key) => env[`WORKBENCH_DELIVERY_SMOKE_${key}`] ?? privateValues[key];
  const allowHttp = env.NODE_ENV === "test" && env.WORKBENCH_DELIVERY_SMOKE_ALLOW_HTTP === "1";
  function origin(input) {
    let url;
    try { url = new URL(input); } catch { fail("ORIGIN_INVALID"); }
    ensure((url.protocol === "https:" || (allowHttp && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "ORIGIN_INVALID");
    return url.origin;
  }
  const baseUrl = origin(value("BASE_URL"));
  const previewOrigin = origin(value("PREVIEW_ORIGIN"));
  ensure(baseUrl !== previewOrigin, "PREVIEW_ORIGIN_MUST_BE_ISOLATED");
  const cookie = value("SESSION_COOKIE") || "";
  const email = value("EMAIL") || "";
  const password = value("PASSWORD") || "";
  ensure(Boolean(cookie) !== Boolean(email && password) && !(cookie && (email || password)), "AUTH_CONFIGURATION_INVALID");
  ensure(!/[\r\n\0]/u.test(cookie) && (!cookie || cookie.includes("=")), "COOKIE_INVALID");
  const timeoutMs = Number(value("TIMEOUT_MS") || 1_800_000);
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 3_600_000, "TIMEOUT_INVALID");
  return { baseUrl, previewOrigin, cookie, email, password, timeoutMs, modelId: value("MODEL_ID"),
    browserProxy: value("BROWSER_PROXY"), prompt: value("PROMPT") || prompt };
}

export function createDeliveryClient(config, fetchImpl = fetch) {
  let cookie = config.cookie;
  return {
    setCookie(value) { cookie = value; },
    sessionCookie() { return cookie; },
    async request(route, { method = "GET", body, headers: initialHeaders, anonymous = false, statuses = [200], preview = false } = {}) {
      const url = new URL(route, config.baseUrl);
      ensure(url.origin === (preview ? config.previewOrigin : config.baseUrl)
        && !url.username && !url.password, "REQUEST_ORIGIN_INVALID");
      ensure(!preview || anonymous, "PREVIEW_MUST_BE_ANONYMOUS");
      const headers = new Headers(initialHeaders);
      headers.set("Accept", "application/json");
      if (!anonymous && cookie) headers.set("Cookie", cookie);
      if (method !== "GET" && method !== "HEAD") headers.set("Origin", config.baseUrl);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      let response;
      try {
        response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual", signal: AbortSignal.timeout(60_000) });
      } catch { fail("HTTP_REQUEST_FAILED"); }
      // Never put request URLs (which can carry share capabilities) or bodies in errors.
      if (!statuses.includes(response.status)) {
        await response.body?.cancel();
        fail(`HTTP_STATUS_${response.status}`);
      }
      return response;
    },
    async json(route, options) {
      const response = await this.request(route, options);
      try { return JSON.parse((await boundedBytes(response, 8 * 1024 * 1024)).toString("utf8")); }
      catch (error) { if (error.code === "RESPONSE_TOO_LARGE") throw error; fail("HTTP_JSON_INVALID"); }
    },
  };
}

async function boundedBytes(response, maximum) {
  const reader = response.body?.getReader();
  ensure(reader, "RESPONSE_BODY_MISSING");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); fail("RESPONSE_TOO_LARGE"); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function executeDeliveryHttpSmoke({ env = process.env, fetchImpl = fetch, sleep = delay,
  browserFactory = openAnonymousBrowser, pdfTools = productionPdfTools, onProgress = () => {} } = {}) {
  const smokeId = randomUUID();
  const evidence = { version: "1.0.0", smokeId, result: "RUNNING", checks: [], cleanup: "not-needed" };
  let client, config, browser, workspaceId, projectId, threadId, runId, shareToken, projectTitle, projectCreationAttempted = false;
  const pass = (name, detail = {}) => { evidence.checks.push({ name, ...detail }); onProgress({ check: name, ...detail }); };
  const mutation = (body, key, statuses = [201]) => ({ method: "POST", body, statuses,
    headers: key ? { "Idempotency-Key": `delivery-${smokeId}-${key}` } : {} });
  async function poll(route, expected, code, timeoutMs = config.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await client.json(route);
      if (expected.includes(result.status)) return result;
      if (terminal.has(result.status) || result.status === "waiting_input" || result.status === "expired") {
        if (result.failure?.code && safeCode(result.failure) !== "SMOKE_FAILED") evidence.remoteFailureCode = result.failure.code;
        fail(result.status === "waiting_input" ? "GENERATION_INPUT_REQUIRED" : code);
      }
      if (Date.now() >= deadline) fail(`${code}_TIMEOUT`);
      await sleep(2_000);
    }
  }
  try {
    config = deliverySmokeConfig(env);
    const submissionPrompt = `[SMOKE] 1.0.0 ${smokeId}\n${config.prompt}`;
    // Match the actual home composer title rule; the UUID is wholly within its first 77 characters.
    const normalizedPrompt = submissionPrompt.trim().replace(/\s+/gu, " ");
    projectTitle = normalizedPrompt.length <= 80 ? normalizedPrompt : `${normalizedPrompt.slice(0, 77)}...`;
    client = createDeliveryClient(config, fetchImpl);
    if (!config.cookie) {
      const response = await client.request("/api/auth/sign-in/email", { ...mutation({ email: config.email, password: config.password }, null, [200]), anonymous: true });
      const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie") || "").split(/,(?=\s*[^;,=]+=[^;,]+)/u);
      const cookie = cookies.map((entry) => entry.split(";", 1)[0]).filter(Boolean).join("; ");
      await response.body?.cancel();
      ensure(cookie, "AUTH_SESSION_MISSING"); client.setCookie(cookie);
    }
    const identity = await client.json("/api/v1/identity/me");
    workspaceId = id(identity.defaultWorkspaceId);
    const models = await client.json("/api/v1/runtime/models");
    const model = models.items?.find((item) => item.supportedWorkflows?.includes("generate") && (!config.modelId || item.id === config.modelId));
    ensure(model, "RUNTIME_MODEL_UNAVAILABLE");
    const capabilities = await client.json("/api/v1/exports/capabilities");
    ensure(["docx", "pdf", "html"].every((format) => capabilities.formats?.[format]?.available), "EXPORT_CAPABILITY_UNAVAILABLE");
    pdfTools.check();
    browser = await browserFactory(config);
    pass("authenticated-services-ready");
    const submitted = await browser.submitFromHome({ prompt: submissionPrompt, projectTitle, workspaceId,
      cookie: client.sessionCookie(), modelIds: models.items.filter((item) => item.supportedWorkflows?.includes("generate")).map((item) => item.id),
      expectedModelId: config.modelId,
      onCreateAttempt() { projectCreationAttempted = true; },
      onProject(project) {
        ensure(project.title === projectTitle && project.workspaceId === workspaceId, "CREATED_PROJECT_SCOPE_INVALID");
        projectId = id(project.id); evidence.projectId = projectId;
      },
      onInitial(initial) {
        ensure(initial.project?.id === projectId && initial.threads?.length === 1 && initial.artifacts?.length === 0
          && initial.board?.nodes?.length === 0, "NEW_PROJECT_NOT_EMPTY");
        threadId = id(initial.threads[0].id);
      },
    });
    runId = id(submitted.run?.id); evidence.runId = runId;
    ensure(submitted.run.projectId === projectId && submitted.run.threadId === threadId, "RUN_IDENTITY_INVALID");
    pass("browser-home-joint-generation-submitted");
    const run = await poll(`/api/v1/runs/${enc(runId)}`, ["succeeded"], "GENERATION_FAILED");
    ensure(run.projectId === projectId && run.threadId === threadId && run.id === runId
      && run.knowledgeReleaseId && run.requestedArtifactKinds?.includes("prd") && run.requestedArtifactKinds?.includes("prototype"), "RUN_SCOPE_INVALID");
    let completed = await client.json(`/api/v1/projects/${enc(projectId)}/bootstrap`);
    const generated = completed.artifacts.filter((artifact) => artifact.currentVersion?.createdByRunId === runId);
    ensure(generated.length === 2 && ["prd", "prototype"].every((kind) => generated.some((artifact) => artifact.kind === kind)), "JOINT_ARTIFACTS_MISSING");
    const versions = {};
    for (const artifact of generated) {
      const versionId = id(artifact.currentVersion.artifactVersionId);
      const raw = await client.json(`/api/v1/artifacts/${enc(artifact.id)}/versions/${enc(versionId)}`);
      const parsed = artifactVersionDetailSchema.safeParse(raw);
      ensure(parsed.success, "ARTIFACT_CONTRACT_INVALID");
      const version = parsed.data;
      ensure(version.status === "ready" && version.createdByRunId === runId && version.artifactId === artifact.id
        && version.artifactVersionId === versionId && version.knowledgeReleaseId === run.knowledgeReleaseId && version.content,
      "ARTIFACT_PIN_INVALID");
      ensure(createHash("sha256").update(canonicalJson(version.content)).digest("hex") === version.checksum, "ARTIFACT_CHECKSUM_INVALID");
      versions[artifact.kind] = version;
    }
    assertPrdV2Structure(versions.prd.content);
    ensure(versions.prd.citations.length > 0 && versions.prototype.citations.length > 0, "KNOWLEDGE_CITATIONS_MISSING");
    ensure(versions.prototype.content.screens?.length > 0, "PROTOTYPE_SCREENS_MISSING");
    pass("knowledge-grounded-joint-artifacts", { prdCitations: versions.prd.citations.length,
      prototypeCitations: versions.prototype.citations.length, prototypeScreens: versions.prototype.content.screens.length });
    const originalPrd = versions.prd;
    const editMarker = `WBEDIT${smokeId.replaceAll("-", "").slice(0, 16)}`;
    const editedDocument = structuredClone(originalPrd.content);
    editedDocument.versionHistory[0].author = editMarker;
    editedDocument.revision.number += 1;
    editedDocument.revision.changedAt = new Date().toISOString();
    editedDocument.revision.summary = "验收：编辑并保存需求文档";
    const artifact = await client.json(`/api/v1/artifacts/${enc(originalPrd.artifactId)}`);
    ensure(artifact.projectId === projectId && artifact.currentVersion?.artifactVersionId === originalPrd.artifactVersionId, "EDIT_BASE_INVALID");
    const savedRaw = await client.json(`/api/v1/artifacts/${enc(originalPrd.artifactId)}/versions`, {
      ...mutation({ kind: "prd", baseArtifactVersionId: originalPrd.artifactVersionId, document: editedDocument }, "edit-prd"),
      headers: { "Idempotency-Key": `delivery-${smokeId}-edit-prd`, "If-Match": etag(artifact.revision) },
    });
    const saved = artifactVersionDetailSchema.safeParse(savedRaw);
    ensure(saved.success && saved.data.status === "ready" && saved.data.artifactId === originalPrd.artifactId
      && saved.data.artifactVersionId !== originalPrd.artifactVersionId && saved.data.version === originalPrd.version + 1
      && saved.data.createdByRunId === null && saved.data.knowledgeReleaseId === originalPrd.knowledgeReleaseId
      && canonicalJson(saved.data.citations) === canonicalJson(originalPrd.citations)
      && canonicalJson(saved.data.content) === canonicalJson(editedDocument)
      && saved.data.checksum === createHash("sha256").update(canonicalJson(editedDocument)).digest("hex"), "EDITED_VERSION_INVALID");
    versions.prd = saved.data;
    const originalAgain = await client.json(`/api/v1/artifacts/${enc(originalPrd.artifactId)}/versions/${enc(originalPrd.artifactVersionId)}`);
    ensure(originalAgain.checksum === originalPrd.checksum
      && canonicalJson(originalAgain.content) === canonicalJson(originalPrd.content), "ORIGINAL_VERSION_MUTATED");
    const board = await client.json(`/api/v1/projects/${enc(projectId)}/board`);
    ensure(board.nodes.some((node) => node.artifactId === originalPrd.artifactId && node.artifactVersionId === originalPrd.artifactVersionId), "PRD_BOARD_PIN_MISSING");
    await client.json(`/api/v1/projects/${enc(projectId)}/board`, { method: "PUT",
      headers: { "Idempotency-Key": `delivery-${smokeId}-pin-edited-prd`, "If-Match": etag(board.revision) },
      body: { viewport: board.viewport, edges: board.edges, nodes: board.nodes.map((node) => node.artifactId === originalPrd.artifactId
        ? { ...node, artifactVersionId: saved.data.artifactVersionId } : node) },
    });
    completed = await client.json(`/api/v1/projects/${enc(projectId)}/bootstrap`);
    const editedNode = completed.board.nodes.find((node) => node.artifactId === originalPrd.artifactId);
    ensure(editedNode?.artifactVersionId === saved.data.artifactVersionId, "EDITED_BOARD_PIN_MISSING");
    await browser.verifyDocument({ projectId, nodeId: editedNode.id, marker: editMarker, cookie: client.sessionCookie() });
    pass("document-edited-saved-and-previewed", { version: saved.data.version });
    const releaseCreated = await client.json(`/api/v1/projects/${enc(projectId)}/releases`, {
      ...mutation({ boardId: id(completed.board.id), boardRevision: completed.board.revision }, "release"),
      headers: { "Idempotency-Key": `delivery-${smokeId}-release`, "If-Match": etag(completed.board.revision) },
    });
    const releaseId = id(releaseCreated.id);
    const release = await poll(`/api/v1/releases/${enc(releaseId)}`, ["ready"], "RELEASE_FAILED", 300_000);
    ensure(release.projectId === projectId, "RELEASE_SCOPE_INVALID");
    ensure(release.artifactPins.some((pin) => pin.artifactId === versions.prd.artifactId
      && pin.artifactVersionId === versions.prd.artifactVersionId), "RELEASE_USES_STALE_DOCUMENT");
    for (const format of ["docx", "pdf", "html"]) {
      const version = format === "html" ? versions.prototype : versions.prd;
      const created = await client.json(`/api/v1/projects/${enc(projectId)}/exports`, mutation({ releaseId, format,
        packaging: "single_file", selection: { kind: "artifact", artifactId: version.artifactId, artifactVersionId: version.artifactVersionId }, options: {} }, format, [202]));
      const exportId = id(created.id);
      const job = await poll(`/api/v1/exports/${enc(exportId)}`, ["succeeded"], "EXPORT_FAILED", 300_000);
      ensure(job.releaseId === releaseId && job.format === format && job.selection?.kind === "artifact"
        && job.selection.artifactVersionId === version.artifactVersionId, "EXPORT_SCOPE_INVALID");
      const response = await client.request(`/api/v1/exports/${enc(exportId)}/content`);
      const bytes = await boundedBytes(response, 64 * 1024 * 1024);
      ensure(bytes.length > 100 && bytes.length === job.output?.byteSize
        && createHash("sha256").update(bytes).digest("hex") === job.output.sha256, "EXPORT_BYTES_INVALID");
      const mime = response.headers.get("content-type") || "";
      ensure(format === "docx" ? (mime.includes("wordprocessingml.document") && bytes.subarray(0, 2).toString() === "PK")
        : format === "pdf" ? (mime.includes("application/pdf") && bytes.subarray(0, 5).toString() === "%PDF-")
          : (mime.includes("text/html") && /<html[\s>]/iu.test(bytes.toString("utf8"))), "EXPORT_FORMAT_INVALID");
      if (format !== "html") {
        const text = format === "pdf" ? pdfTools.text(bytes)
          : Buffer.from(unzipSync(bytes, { filter: (file) => file.name === "word/document.xml" })["word/document.xml"] || []).toString("utf8");
        ensure(text.replace(/\s+/gu, "").includes(editMarker), "EXPORTED_DOCUMENT_EDIT_MISSING");
      }
      pass(`${format}-download-verified`, { byteSize: bytes.length });
      if (format === "html") {
        const preview = await client.json(`/api/v1/exports/${enc(exportId)}/preview-token`, mutation(undefined, null, [200]));
        const rendered = await client.request(preview.url, { anonymous: true, preview: true });
        ensure((rendered.headers.get("content-type") || "").includes("text/html"), "ISOLATED_PREVIEW_INVALID");
        ensure((await boundedBytes(rendered, 64 * 1024 * 1024)).length > 100, "ISOLATED_PREVIEW_EMPTY");
        pass("isolated-prototype-preview");
      }
    }
    const share = await client.json(`/api/v1/projects/${enc(projectId)}/shares/rotate`, mutation({ releaseId,
      artifactVersionId: versions.prototype.artifactVersionId, scope: "view", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }, "share"));
    shareToken = id(share.token);
    const publicRoute = `/api/v1/public/shares/${enc(shareToken)}`;
    const publicShare = await client.json(publicRoute, { anonymous: true });
    ensure(publicShare.scope === "view" && publicShare.release?.id === releaseId, "PUBLIC_SHARE_INVALID");
    ensure(publicShare.release.artifactPins.length === 1 && publicShare.release.artifactPins[0].kind === "prototype", "SHARE_SCOPE_TOO_BROAD");
    for (const version of [versions.prototype]) {
      const publicVersion = await client.json(`${publicRoute}/artifacts/${enc(version.artifactId)}/versions/${enc(version.artifactVersionId)}`, { anonymous: true });
      ensure(publicVersion.artifactVersionId === version.artifactVersionId && publicVersion.checksum === version.checksum, "PUBLIC_ARTIFACT_PIN_INVALID");
      ensure(publicVersion.citations?.length === 0 && !("knowledgeReleaseId" in publicVersion)
        && !("createdByRunId" in publicVersion), "PUBLIC_SHARE_EXPOSES_PRIVATE_EVIDENCE");
    }
    await (await client.request(`${publicRoute}/artifacts/${enc(versions.prd.artifactId)}/versions/${enc(versions.prd.artifactVersionId)}`,
      { anonymous: true, statuses: [404] })).body?.cancel();
    const interactions = await browser.verifyShare(`${config.baseUrl}/share/${enc(shareToken)}`, publicShare.release, versions.prototype.content);
    ensure(interactions?.navigationCount >= 2 && interactions?.toggleCount >= 2, "PROTOTYPE_INTERACTION_NOT_VERIFIED");
    pass("anonymous-prototype-rendered-document-private");
    pass("anonymous-prototype-navigation-and-toggle-verified", interactions);
    await client.json(`/api/v1/projects/${enc(projectId)}/shares/revoke-all`, mutation(undefined, null, [200]));
    await (await client.request(publicRoute, { anonymous: true, statuses: [404, 410] })).body?.cancel();
    for (const version of Object.values(versions)) {
      await (await client.request(`${publicRoute}/artifacts/${enc(version.artifactId)}/versions/${enc(version.artifactVersionId)}`,
        { anonymous: true, statuses: [404, 410] })).body?.cancel();
    }
    await browser.verifyRevoked();
    pass("share-revocation-enforced");
    evidence.result = "PASS";
  } catch (error) {
    evidence.result = "FAIL"; evidence.failureCode = safeCode(error);
  } finally {
    if (!projectId && projectCreationAttempted && client) {
      try {
        const page = await client.json(`/api/v1/projects?relationship=owned&q=${encodeURIComponent(projectTitle)}&limit=100`);
        const matches = page.items.filter((item) => item.title === projectTitle && item.workspaceId === workspaceId
          && item.role === "owner" && item.relationship === "owned");
        ensure(page.nextCursor === null && matches.length <= 1, "CREATED_PROJECT_AMBIGUOUS");
        if (matches.length === 1) { projectId = id(matches[0].id); evidence.projectId = projectId; }
        else evidence.cleanup = "project-creation-not-confirmed";
      } catch { evidence.cleanup = "incomplete"; evidence.cleanupFailures = ["resolve-created-project"]; }
    }
    if (projectId && client) {
      const failures = [];
      const clean = async (name, action) => { try { await action(); } catch { failures.push(name); } };
      await clean("revoke-shares", () => client.json(`/api/v1/projects/${enc(projectId)}/shares/revoke-all`, mutation(undefined, null, [200])));
      // A lost submit response must not leave an untracked run: recover only this new project's thread.
      if (!runId) await clean("resolve-run", async () => {
        const snapshot = await client.json(`/api/v1/projects/${enc(projectId)}/bootstrap${threadId ? `?threadId=${enc(threadId)}` : ""}`);
        ensure(snapshot.project?.id === projectId && snapshot.threads?.length === 1, "CLEANUP_SCOPE_INVALID");
        const ownThreadId = id(snapshot.threads[0].id);
        ensure(!threadId || threadId === ownThreadId, "CLEANUP_SCOPE_INVALID");
        threadId = ownThreadId;
        if (snapshot.latestRun?.id) runId = id(snapshot.latestRun.id);
      });
      if (runId) await clean("cancel-run", async () => {
        const run = await client.json(`/api/v1/runs/${enc(runId)}`);
        ensure(run.projectId === projectId && run.threadId === threadId, "CLEANUP_SCOPE_INVALID");
        if (!terminal.has(run.status)) {
          await client.json(`/api/v1/runs/${enc(runId)}/cancel`, mutation(undefined, "cleanup-cancel", [200, 202]));
          await poll(`/api/v1/runs/${enc(runId)}`, [...terminal], "CLEANUP_RUN_FAILED", 120_000);
        }
      });
      // Listing is scoped to the project created above, also covering a lost export POST response.
      await clean("cancel-exports", async () => {
        const page = await client.json(`/api/v1/projects/${enc(projectId)}/exports?limit=100`);
        ensure(page.nextCursor === null, "CLEANUP_EXPORT_PAGE_UNBOUNDED");
        for (const job of page.items) if (!terminal.has(job.status)) {
          await client.json(`/api/v1/exports/${enc(job.id)}/cancel`, { ...mutation(undefined, null, [200]), headers: { "If-Match": etag(job.revision) } });
        }
      });
      await clean("archive-project", async () => {
        const snapshot = await client.json(`/api/v1/projects/${enc(projectId)}/bootstrap`);
        ensure(snapshot.project.id === projectId, "CLEANUP_SCOPE_INVALID");
        const archived = await client.json(`/api/v1/projects/${enc(projectId)}`, { method: "DELETE", headers: { "If-Match": etag(snapshot.project.revision) } });
        ensure(archived.status === "archived", "ARCHIVE_FAILED");
      });
      evidence.cleanup = failures.length ? "incomplete" : "project-archived-shares-revoked";
      if (failures.length) { evidence.cleanupFailures = failures; evidence.result = "FAIL"; }
    }
    if (client?.sessionCookie()) {
      try {
        await client.json("/api/auth/sign-out", mutation({}, null, [200]));
        ensure(await client.json("/api/auth/get-session") === null, "SESSION_STILL_ACTIVE");
        evidence.sessionCleanup = "signed-out";
      } catch (error) {
        evidence.result = "FAIL"; evidence.sessionCleanup = "failed"; evidence.sessionCleanupFailure = safeCode(error);
      } finally { client.setCookie(""); }
    }
    try { await browser?.close(); } catch { evidence.result = "FAIL"; evidence.browserCleanupFailed = true; }
  }
  return { ok: evidence.result === "PASS", evidence };
}

export async function submitDeliveryFromHome(page, { baseUrl, prompt: submittedPrompt, projectTitle, workspaceId,
  modelIds, expectedModelId, onCreateAttempt, onProject, onInitial, screenshotPath }) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const input = page.getByRole("textbox", { name: "提示词", exact: true });
  await input.fill(submittedPrompt);
  await page.getByRole("button", { name: "选择生成类型", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "需求文档＋原型 生成关联的文档与可交互原型", exact: true }).click();
  ensure(await input.inputValue() === submittedPrompt, "BROWSER_PROMPT_INPUT_MISMATCH");
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: false });

  const match = (response, method, route) => {
    const url = new URL(response.url());
    return url.origin === baseUrl && response.request().method() === method
      && (typeof route === "string" ? url.pathname === route : route.test(url.pathname));
  };
  // Attach all listeners before the real click: a fast create/bootstrap/submit must not escape observation.
  // Each promise handles rejection immediately, even if an earlier step fails and closes the page.
  const capture = (predicate) => page.waitForResponse(predicate, { timeout: 90_000 })
    .then(async (response) => ({ response, value: await response.json() }))
    .catch(() => ({ failed: true }));
  const createdResponse = capture((response) => {
    if (!match(response, "POST", `/api/v1/workspaces/${enc(workspaceId)}/projects`)) return false;
    try { return response.request().postDataJSON()?.title === projectTitle; } catch { return false; }
  });
  const initialResponse = capture((response) => match(response, "GET", /^\/api\/v1\/projects\/[^/]+\/bootstrap$/u));
  const intentResponse = capture((response) => match(response, "POST", /^\/api\/v1\/threads\/[^/]+\/submission-intents$/u));
  const submittedResponse = capture((response) => match(response, "POST", /^\/api\/v1\/submission-intents\/[^/]+\/submit$/u));
  async function receive(pending, status) {
    const captured = await pending;
    ensure(!captured.failed, "BROWSER_SUBMISSION_RESPONSE_MISSING");
    ensure(captured.response.status() === status, `HTTP_STATUS_${captured.response.status()}`);
    return captured;
  }
  onCreateAttempt();
  await page.getByRole("button", { name: "提交提示", exact: true }).click();
  const created = await receive(createdResponse, 201);
  onProject(created.value);
  const initial = await receive(initialResponse, 200);
  onInitial(initial.value);
  const intent = await receive(intentResponse, 201);
  ensure(new URL(intent.response.url()).pathname === `/api/v1/threads/${enc(initial.value.threads[0].id)}/submission-intents`, "BROWSER_SUBMISSION_SCOPE_INVALID");
  const request = intent.response.request().postDataJSON()?.request;
  ensure(request?.prompt === submittedPrompt && request.workflow === "generate" && request.targetSurface === "web"
    && request.sourceIds?.length === 0 && request.artifactTargets?.length === 0
    && request.requestedArtifactKinds?.length === 2
    && ["prd", "prototype"].every((kind) => request.requestedArtifactKinds.includes(kind)), "BROWSER_SUBMISSION_REQUEST_INVALID");
  ensure(modelIds.includes(request.modelId) && (!expectedModelId || request.modelId === expectedModelId), "BROWSER_MODEL_MISMATCH");
  const submitted = await receive(submittedResponse, 202);
  ensure(new URL(submitted.response.url()).pathname === `/api/v1/submission-intents/${enc(intent.value.id)}/submit`, "BROWSER_SUBMISSION_SCOPE_INVALID");
  return submitted.value;
}

export async function verifyDeliveryPrototypeInteractions(page, document, { timeoutMs = 10_000 } = {}) {
  const screen = page.locator("[data-canvas-visual-screen]").first();
  await screen.waitFor({ state: "visible" });
  const initialScreenId = await screen.getAttribute("data-canvas-screen-id");
  ensure(document.screens.length >= 2 && document.screens.some((item) => item.id === initialScreenId), "PROTOTYPE_INTERACTIVE_SCREENS_MISSING");
  const actions = new Map(document.actions.map((action) => [action.id, action]));
  const bindings = new Map(document.bindings.map((binding) => [binding.id, binding]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const safeActions = (node) => {
    const visited = new Set();
    for (let current = node; current; current = current.parentId ? nodes.get(current.parentId) : null) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      if (!current.actionIds.map((actionId) => actions.get(actionId))
        .every((action) => action && ["navigate", "setState"].includes(action.kind))) return false;
    }
    return true;
  };
  const clickActions = (node) => node.actionIds.map((actionId) => actions.get(actionId))
    .filter((action) => action && ["click", "press"].includes(action.event));
  async function until(check, code) {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) {
      ensure(Date.now() < deadline, code);
      await delay(50);
    }
  }
  // Choose generated controls by their rendered accessible names and actual declared behavior.
  // Never click arbitrary buttons: openUrl/submit actions may have effects outside this synthetic project.
  let toggle;
  for (const node of document.nodes.filter((item) => item.screenId === initialScreenId
    && item.kind === "input" && item.inputType === "checkbox" && item.label?.trim() && safeActions(item))) {
    const writableBinding = node.bindingIds.some((bindingId) => {
      const binding = bindings.get(bindingId);
      return binding?.nodeId === node.id && binding.property === "value" && binding.source.kind === "variable";
    });
    if (!writableBinding) continue;
    const candidate = screen.getByRole("checkbox", { name: node.label, exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible() && await candidate.isEnabled()) { toggle = candidate; break; }
  }
  ensure(toggle, "PROTOTYPE_NAMED_TOGGLE_MISSING");
  const originalValue = await toggle.isChecked();
  await toggle.click();
  await until(async () => await toggle.isChecked() === !originalValue, "PROTOTYPE_TOGGLE_INERT");

  async function navigation(sourceScreenId, targetScreenId) {
    for (const node of document.nodes.filter((item) => item.screenId === sourceScreenId
      && item.kind === "button" && item.label?.trim() && safeActions(item))) {
      const navigations = clickActions(node).filter((action) => action.kind === "navigate");
      if (navigations.length !== 1 || navigations[0].targetScreenId === sourceScreenId
        || (targetScreenId && navigations[0].targetScreenId !== targetScreenId)) continue;
      const candidate = screen.getByRole("button", { name: node.label, exact: true });
      if (await candidate.count() !== 1 || !await candidate.isVisible() || !await candidate.isEnabled()) continue;
      const destination = navigations[0].targetScreenId;
      ensure(document.screens.some((item) => item.id === destination), "PROTOTYPE_NAVIGATION_TARGET_INVALID");
      await candidate.click();
      await until(async () => await screen.getAttribute("data-canvas-screen-id") === destination, "PROTOTYPE_NAVIGATION_INERT");
      return destination;
    }
    fail(targetScreenId ? "PROTOTYPE_RETURN_NAVIGATION_MISSING" : "PROTOTYPE_NAVIGATION_MISSING");
  }
  const destination = await navigation(initialScreenId);
  await navigation(destination, initialScreenId);
  await until(async () => await toggle.isVisible() && await toggle.isChecked() === !originalValue, "PROTOTYPE_TOGGLE_STATE_LOST");
  await toggle.click();
  await until(async () => await toggle.isChecked() === originalValue, "PROTOTYPE_TOGGLE_RESTORE_FAILED");
  return { navigationCount: 2, toggleCount: 2 };
}

async function openAnonymousBrowser(config) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, ...(config.browserProxy ? { proxy: { server: config.browserProxy } } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const screenshotRoot = path.join(repository, "output/audit/1.0.0");
  return {
    async submitFromHome(options) {
      const privateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        await privateContext.addCookies(browserCookies(options.cookie, config.baseUrl));
        const privatePage = await privateContext.newPage();
        privatePage.setDefaultTimeout(30_000);
        await mkdir(screenshotRoot, { recursive: true });
        return await submitDeliveryFromHome(privatePage, { ...options, baseUrl: config.baseUrl,
          screenshotPath: path.join(screenshotRoot, "delivery-home-input.png") });
      } finally { await privateContext.close(); }
    },
    async verifyDocument({ projectId, nodeId, marker, cookie }) {
      const privateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        await privateContext.addCookies(browserCookies(cookie, config.baseUrl));
        const privatePage = await privateContext.newPage();
        privatePage.setDefaultTimeout(30_000);
        await privatePage.goto(`${config.baseUrl}/projects/${enc(projectId)}`, { waitUntil: "domcontentloaded" });
        const node = privatePage.locator(`.react-flow__node[data-id=${JSON.stringify(nodeId)}]`);
        await node.focus(); await node.press("Enter");
        const author = privatePage.getByRole("textbox", { name: "版本1作者", exact: true });
        await author.waitFor({ state: "visible" });
        ensure(await author.inputValue() === marker, "SAVED_DOCUMENT_NOT_VISIBLE");
        await mkdir(screenshotRoot, { recursive: true });
        await privatePage.screenshot({ path: path.join(screenshotRoot, "delivery-document-edited.png"), fullPage: false });
      } finally { await privateContext.close(); }
    },
    async verifyShare(url, release, document) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByText("共享项目 · 版本", { exact: false }).waitFor();
      for (const kind of ["prototype"]) {
        const pin = release.artifactPins.find((item) => item.kind === kind);
        const toggleScreenId = document.nodes.find((node) => node.kind === "input" && node.inputType === "checkbox")?.screenId;
        const boardNode = release.boardSnapshot.nodes.find((item) => item.artifactId === pin?.artifactId && item.data?.screenId === toggleScreenId)
          ?? release.boardSnapshot.nodes.find((item) => item.artifactId === pin?.artifactId);
        ensure(pin, "BROWSER_ARTIFACT_MISSING");
        await page.locator("aside").getByRole("button", { name: boardNode?.data?.title || pin.title, exact: true }).first().click();
        await page.locator("[data-canvas-visual-screen]").first().waitFor({ state: "visible" });
        const interactions = await verifyDeliveryPrototypeInteractions(page, document);
        await mkdir(screenshotRoot, { recursive: true });
        await page.screenshot({ path: path.join(screenshotRoot, `delivery-share-${kind}.png`), fullPage: false });
        return interactions;
      }
    },
    async verifyRevoked() {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText("分享链接无效或已失效", { exact: true }).waitFor();
    },
    close: () => browser.close(),
  };
}

function browserCookies(cookie, baseUrl) {
  return cookie.split(";").map((entry) => {
    const separator = entry.indexOf("=");
    return { name: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim(), url: baseUrl,
      secure: baseUrl.startsWith("https:"), httpOnly: true, sameSite: "Lax" };
  });
}

const productionPdfTools = {
  check() {
    const result = spawnSync("pdftotext", ["-v"], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    ensure(result.status === 0 && !result.error, "PDF_TEXT_TOOL_UNAVAILABLE");
  },
  text(bytes) {
    const result = spawnSync("pdftotext", ["-", "-"], { input: bytes, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    ensure(result.status === 0 && !result.error, "PDF_TEXT_EXTRACTION_FAILED");
    return result.stdout;
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log(`WORKBENCH_DELIVERY_SMOKE_CONFIRM_WRITE=${confirmation}
WORKBENCH_DELIVERY_SMOKE_CONFIG_FILE=/absolute/private/0600/config.json (outside repository)
JSON keys: BASE_URL, PREVIEW_ORIGIN, EMAIL + PASSWORD or SESSION_COOKIE; optional MODEL_ID, TIMEOUT_MS, BROWSER_PROXY, PROMPT.
Equivalent WORKBENCH_DELIVERY_SMOKE_* environment variables override file fields.
Requires local Playwright Chromium and pdftotext (checked before model generation).
Uses the real home composer for joint generation, edits and saves PRD, validates retained citations and edited DOCX/PDF bytes, checks private document rendering and anonymous prototype navigation/toggle persistence/sharing/revocation, then archives only its own project and signs out its session.
Output contains counts/statuses and created project/run IDs, never cookies, passwords, tokens or generated content.
Screenshots: output/audit/1.0.0/delivery-home-input.png, delivery-document-edited.png and delivery-share-prototype.png. Archiving preserves database audit history.`);
  } else {
    const result = await executeDeliveryHttpSmoke({ onProgress: (item) => console.log(JSON.stringify(item)) });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  }
}
