// New Studio management UI with strict fixture contracts; not live-service acceptance.
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  "../../output/audit/1.0.0/studio-management/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-16T00:00:00.000Z",
  projectId = "management-project";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const project = {
  id: projectId,
  workspaceId: "workspace-1",
  title: "管理验收",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
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
const board = {
  id: "board-one",
  projectId,
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
};
const member = (id, role, name) => ({
  projectId,
  principalId: id,
  role,
  displayName: name,
  email: `${id}@example.test`,
  createdAt: now,
  updatedAt: now,
});
let accessRole = "owner",
  members = [
    member("owner", "owner", "项目所有者"),
    member("editor", "editor", "张编辑"),
  ];
const token = `wbi_${"a".repeat(48)}.${"b".repeat(43)}`;
const invitation = (index) => ({
  invitation: {
    id: `invitation-${index}`,
    projectId,
    workspaceId: project.workspaceId,
    email: `invite${index}@example.test`,
    role: "viewer",
    status: "pending",
    deliveryStatus: "not_configured",
    createdById: "owner",
    acceptedById: null,
    revision: 1,
    expiresAt: "2099-01-01T00:00:00Z",
    acceptedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  },
  token,
});
let invitations = Array.from({ length: 35 }, (_, index) => invitation(index));
const makeRelease = (version) => {
  const pins = ["prd", "prototype"].map((kind, position) => ({
    position,
    artifactId: `artifact-${kind}`,
    artifactVersionId: `${kind}-v${version}`,
    title: kind === "prd" ? "订单需求" : "订单原型",
    kind,
    version,
    schemaVersion: kind === "prd" ? 3 : 1,
    checksum: "a".repeat(64),
    assets: [],
  }));
  return {
    id: `release-${version}`,
    projectId,
    version,
    status: "ready",
    createdById: "owner",
    boardId: board.id,
    boardRevision: 1,
    boardSnapshot: board,
    boardChecksum: "a".repeat(64),
    artifactPins: pins,
    manifest: {
      protocol: "workbench.project-release.v1",
      projectId,
      releaseVersion: version,
      board: { id: board.id, revision: 1, checksum: "a".repeat(64) },
      artifacts: pins,
    },
    manifestSha256: "b".repeat(64),
    failure: null,
    createdAt: now,
    finishedAt: now,
    updatedAt: now,
  };
};
const releases = [makeRelease(2), makeRelease(1)];
const bytes = Buffer.from("controlled export fixture bytes");
const job = (id, status) => ({
  id,
  releaseId: "release-1",
  createdById: "owner",
  format: "docx",
  packaging: "single_file",
  selection: {
    kind: "artifact",
    artifactId: "artifact-prd",
    artifactVersionId: "prd-v1",
  },
  status,
  revision: 1,
  options: {},
  output:
    status === "succeeded"
      ? {
          blobId: `blob-${id}`,
          mediaType: "application/octet-stream",
          byteSize: bytes.length,
          sha256: digest(bytes),
          fileName: `${id}.docx`,
        }
      : null,
  failure:
    status === "failed"
      ? { code: "FIXTURE_EXPORT_FAILURE", detail: "导出失败，可按原版本重试" }
      : null,
  createdAt: now,
  startedAt: status === "queued" ? null : now,
  finishedAt: ["succeeded", "failed", "cancelled"].includes(status)
    ? now
    : null,
  updatedAt: now,
});
let jobs = [
    job("bad-download", "succeeded"),
    job("good-download", "succeeded"),
    job("failed-export", "failed"),
  ],
  shares = [];
const results = {
    evidence:
      "mocked API management UI, actual browser download integrity checks; not real DOCX generation",
    checks: [],
    errors: [],
    unknown: [],
  },
  commands = [],
  downloads = [];
let failInvitation = true,
  failExport = true,
  memberConflict = true,
  ownerReads = 0;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([
  { name: "workbench.session_token", value: "management-fixture", url: origin },
]);
await context.addInitScript(() =>
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async () => {
        throw new Error("fixture clipboard denied");
      },
    },
    configurable: true,
  }),
);
const json = (route, value, status = 200, etag = `"${project.revision}"`) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { etag },
    body: JSON.stringify(value),
  });
const problem = (route, status, detail) =>
  json(route, { type: "about:blank", title: detail, status, detail }, status);
await context.route("**/api/auth/**", (route) =>
  json(route, {
    session: {
      id: "session",
      token: "management-fixture",
      userId: "owner",
      expiresAt: "2099-01-01T00:00:00Z",
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: "owner",
      name: "项目所有者",
      email: "owner@example.test",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  }),
);
await context.route("**/api/v1/**", async (route) => {
  const request = route.request(),
    url = new URL(request.url()),
    path = url.pathname,
    method = request.method();
  const body =
    method === "GET" || method === "DELETE" ? null : request.postDataJSON();
  if (method !== "GET")
    commands.push({
      path,
      method,
      body,
      key: request.headers()["idempotency-key"],
      etag: request.headers()["if-match"],
    });
  if (path.endsWith("/identity/me"))
    return json(route, {
      id: "owner",
      issuer: "https://identity.example.test",
      subject: "fixture",
      email: "owner@example.test",
      displayName: "项目所有者",
      defaultWorkspaceId: project.workspaceId,
    });
  if (path.endsWith("/bootstrap"))
    return json(route, {
      project,
      access: { role: accessRole },
      threads: [thread],
      selectedThreadId: thread.id,
      entries: [],
      board,
      artifacts: [],
      latestRun: null,
    });
  if (path.endsWith("/runtime/models"))
    return json(route, {
      items: [
        {
          id: "model",
          displayName: "验证模型",
          description: null,
          supportedWorkflows: ["generate", "edit"],
          supportsThinking: true,
          supportsReasoningEffort: false,
        },
      ],
    });
  if (path.endsWith("/design-presets")) return json(route, { items: [] });
  if (path.endsWith("/import-sources") || path.endsWith("/design-systems"))
    return json(route, { items: [], nextCursor: null });
  if (/\/prototype-v2\/(plans|shares|exports)$/.test(path))
    return json(route, []);
  if (path.endsWith("/submission-intents/current"))
    return json(route, { item: null });
  if (path.includes("/workspaces/") && path.endsWith("/members")) {
    ownerReads++;
    return json(route, {
      items: [
        {
          principalId: "new-member",
          role: "member",
          displayName: "新同事",
          email: "new@example.test",
        },
      ],
      nextCursor: null,
    });
  }
  if (path.endsWith(`/projects/${projectId}/members`))
    return json(route, { items: members });
  if (path.includes(`/projects/${projectId}/members/`)) {
    if (request.headers()["if-match"] !== `"${project.revision}"`)
      return problem(route, 412, "Project changed");
    if (memberConflict) {
      memberConflict = false;
      project.revision++;
      return problem(route, 412, "Project changed");
    }
    const id = path.split("/").at(-1);
    project.revision++;
    if (method === "DELETE") {
      members = members.filter((m) => m.principalId !== id);
      return route.fulfill({
        status: 204,
        headers: { etag: `"${project.revision}"` },
      });
    }
    let result = members.find((m) => m.principalId === id);
    if (!result) {
      result = member(id, body.role, "新同事");
      members.push(result);
    } else result.role = body.role;
    return json(route, result);
  }
  if (path.endsWith("/invitations")) {
    ownerReads++;
    if (method === "POST") {
      if (failInvitation) {
        failInvitation = false;
        return problem(route, 503, "邀请暂时不可用，请重试");
      }
      assert.equal(request.headers()["if-match"], `"${project.revision}"`);
      project.revision++;
      const item = invitation(invitations.length);
      Object.assign(item.invitation, body);
      invitations.unshift(item);
      return json(route, { ...item, deliveryStatus: "not_configured" }, 201);
    }
    const filtered = invitations.filter(
        (item) =>
          !url.searchParams.get("status") ||
          item.invitation.status === url.searchParams.get("status"),
      ),
      offset = Number(url.searchParams.get("cursor") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 30);
    return json(route, {
      items: filtered.slice(offset, offset + limit),
      nextCursor:
        offset + limit < filtered.length ? String(offset + limit) : null,
    });
  }
  if (path.includes("/invitations/") && method === "DELETE") {
    assert.equal(request.headers()["if-match"], `"${project.revision}"`);
    project.revision++;
    const item = invitations.find((item) =>
      path.endsWith(`/${item.invitation.id}`),
    );
    Object.assign(item.invitation, {
      status: "revoked",
      revokedAt: now,
      revision: item.invitation.revision + 1,
    });
    item.token = null;
    return json(route, item.invitation);
  }
  if (path.endsWith("/releases"))
    return json(route, {
      items: url.searchParams.has("cursor") ? [releases[1]] : [releases[0]],
      nextCursor: url.searchParams.has("cursor") ? null : "older",
    });
  if (path.endsWith(`/projects/${projectId}/shares`)) {
    ownerReads++;
    return json(route, {
      items: shares,
      activeCount: shares.filter((s) => s.status === "active").length,
      nextCursor: null,
    });
  }
  if (path.endsWith("/shares/rotate")) {
    shares.forEach((s) =>
      Object.assign(s, { status: "revoked", revokedAt: now }),
    );
    const share = {
      id: `share-${shares.length}`,
      releaseId: body.releaseId,
      artifactVersionId: body.artifactVersionId,
      createdById: "owner",
      scope: "view",
      status: "active",
      revision: 1,
      expiresAt: body.expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    shares.unshift(share);
    return json(route, {
      share,
      token: `wbs_${"c".repeat(43)}`,
      revokedGrantCount: shares.length - 1,
    });
  }
  if (path.endsWith("/shares/revoke-all")) {
    shares.forEach((s) =>
      Object.assign(s, { status: "revoked", revokedAt: now }),
    );
    return json(route, { projectId, activeGrantCount: 0 });
  }
  if (path.endsWith(`/projects/${projectId}/exports`)) {
    if (method === "POST") {
      if (failExport) {
        failExport = false;
        return problem(route, 503, "导出提交暂时不可用");
      }
      const created = {
        ...job(`created-export-${jobs.length}`, "queued"),
        ...body,
      };
      jobs.unshift(created);
      return json(route, created, 201, '"1"');
    }
    return json(route, { items: jobs, nextCursor: null });
  }
  if (path.includes("/exports/") && path.endsWith("/cancel")) {
    const found = jobs.find((j) => path.includes(`/${j.id}/`));
    assert.equal(request.headers()["if-match"], `"${found.revision}"`);
    Object.assign(found, {
      status: "cancelled",
      revision: found.revision + 1,
      finishedAt: now,
    });
    return json(route, found, 200, `"${found.revision}"`);
  }
  if (path.includes("/exports/") && path.endsWith("/content"))
    return route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: { etag: `"sha256:${digest(bytes)}"` },
      body: path.includes("bad-download")
        ? Buffer.alloc(bytes.length, 120)
        : bytes,
    });
  results.unknown.push(`${method} ${path}`);
  return problem(route, 404, "Missing fixture route");
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on("pageerror", (error) => results.errors.push(error.message));
page.on("download", (download) => downloads.push(download));
try {
  await page.goto(`${origin}/studio/${projectId}?view=project`, {
    waitUntil: "networkidle",
  });
  const editor = page.getByRole("article", {
    name: "成员 张编辑",
    exact: true,
  });
  await editor.getByRole("combobox").selectOption("viewer");
  await editor.getByRole("button", { name: "保存成员角色" }).click();
  await page
    .getByText("内容已被其他操作更新，请核对最新状态后重试。输入内容已保留。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await editor.getByRole("combobox").inputValue(), "viewer");
  await editor.getByRole("button", { name: "保存成员角色" }).click();
  await editor.getByText("只读成员", { exact: true }).first().waitFor();
  assert.equal(members.find((m) => m.principalId === "editor").role, "viewer");
  await editor.getByText("移除成员", { exact: true }).click();
  await editor.getByRole("button", { name: "确认移除 张编辑" }).click();
  await editor.waitFor({ state: "detached" });
  await page.getByText("添加已有工作区成员", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "待添加的工作区成员" })
    .selectOption("new-member");
  await page.getByRole("button", { name: "添加到项目" }).click();
  await page
    .getByRole("article", { name: "成员 新同事", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("article", { name: "成员 项目所有者", exact: true })
      .getByRole("combobox")
      .isDisabled(),
    true,
  );
  results.checks.push(
    "owner can update/add/remove members with the latest project CAS; a conflict preserves the chosen role and the last owner remains protected",
  );
  await page
    .getByRole("textbox", { name: "邀请邮箱" })
    .fill("New@Example.test");
  await page.getByRole("button", { name: "创建邀请" }).click();
  await page.getByText("邀请暂时不可用，请重试", { exact: true }).waitFor();
  await page.getByRole("button", { name: "创建邀请" }).click();
  const invited = page.getByRole("article", {
    name: "邀请 new@example.test",
    exact: true,
  });
  await invited.waitFor();
  const posts = commands.filter(
    (command) =>
      command.method === "POST" && command.path.endsWith("/invitations"),
  );
  assert.equal(posts.length, 2);
  assert.equal(posts[0].key, posts[1].key);
  assert.equal(posts[1].body.email, "new@example.test");
  const inviteUrl = await invited
    .getByRole("textbox", { name: "邀请链接" })
    .inputValue();
  assert.equal(new URL(inviteUrl).search, "");
  assert(new URL(inviteUrl).hash.startsWith("#token=wbi_"));
  await invited.getByRole("button", { name: "复制邀请链接" }).click();
  await invited
    .getByText("自动复制不可用，请选中上方链接手动复制。", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "加载更多邀请" }).click();
  await page
    .getByRole("article", { name: "邀请 invite34@example.test", exact: true })
    .waitFor();
  await invited.getByRole("button", { name: "撤销邀请" }).click();
  await invited.getByText(/已撤销/).waitFor();
  assert.equal(await invited.getByRole("textbox").count(), 0);
  const revokedResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/invitations?status=revoked") ||
      (response.url().includes("/invitations?") &&
        new URL(response.url()).searchParams.get("status") === "revoked"),
  );
  await page
    .getByRole("combobox", { name: "邀请状态" })
    .selectOption("revoked");
  await revokedResponse;
  await invited.waitFor();
  assert.equal(await page.locator('article[aria-label^="邀请 "]').count(), 1);
  results.checks.push(
    "invitation retries reuse the exact normalized intent, latest project revision, owner-only paginated filters and fragment links with a manual-copy fallback; revoke removes the token",
  );
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await page.getByRole("button", { name: "加载更多发布" }).click();
  await page.getByRole("article", { name: "发布 1", exact: true }).waitFor();
  await page
    .getByRole("combobox", { name: "项目分享的固定原型" })
    .selectOption(JSON.stringify(["release-1", "prototype-v1"]));
  await page.getByRole("button", { name: "生成链接并替换旧链接" }).click();
  await page.getByRole("textbox", { name: "项目分享链接" }).waitFor();
  assert.equal(shares[0].artifactVersionId, "prototype-v1");
  assert.match(
    await page.getByRole("textbox", { name: "项目分享链接" }).inputValue(),
    /\/share\/wbs_/,
  );
  await page.getByText("撤销项目级分享", { exact: true }).click();
  await page.getByRole("button", { name: "确认撤销所有项目级链接" }).click();
  await page
    .getByRole("textbox", { name: "项目分享链接" })
    .waitFor({ state: "detached" });
  assert.equal(shares[0].status, "revoked");
  results.checks.push(
    "project sharing chooses an exact historical published prototype after pagination, exposes a real token URL, and clears it after confirmed revocation",
  );
  const releaseOne = page.getByRole("article", { name: "发布 1", exact: true });
  await releaseOne
    .getByRole("button", { name: "导出 DOCX", exact: true })
    .click();
  await page.getByText("导出提交暂时不可用", { exact: true }).waitFor();
  await releaseOne
    .getByRole("button", { name: "导出 DOCX", exact: true })
    .click();
  await page
    .getByRole("article", { name: `导出 ${jobs[0].id}`, exact: true })
    .waitFor();
  const exportPosts = commands.filter(
    (command) => command.method === "POST" && command.path.endsWith("/exports"),
  );
  assert.equal(exportPosts[0].key, exportPosts[1].key);
  assert.equal(exportPosts[1].body.selection.artifactVersionId, "prd-v1");
  await page
    .getByRole("article", { name: `导出 ${jobs[0].id}`, exact: true })
    .getByRole("button", { name: "取消导出" })
    .click();
  await page
    .getByRole("heading", { name: "DOCX · 已取消", exact: true })
    .waitFor();
  await page
    .getByRole("article", { name: "导出 failed-export", exact: true })
    .getByRole("button", { name: "重新导出固定版本" })
    .click();
  await page
    .getByText("已按原发布与原版本创建新的导出任务", { exact: true })
    .waitFor();
  assert.equal(jobs[0].releaseId, "release-1");
  assert.equal(jobs[0].selection.artifactVersionId, "prd-v1");
  await page
    .getByRole("article", { name: "导出 bad-download", exact: true })
    .getByRole("button", { name: "下载并校验" })
    .click();
  await page
    .getByText("文件内容校验失败，请重新下载", { exact: true })
    .waitFor();
  assert.equal(downloads.length, 0);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("article", { name: "导出 good-download", exact: true })
    .getByRole("button", { name: "下载并校验" })
    .click();
  const downloaded = await downloadPromise;
  assert.equal(digest(await readFile(await downloaded.path())), digest(bytes));
  results.checks.push(
    "document exports preserve exact release/version and retry identity, cancel only on server state, retry old failures against the original version, reject corrupt bytes and deliver verified bytes",
  );
  accessRole = "viewer";
  const beforeReads = ownerReads;
  await page.goto(`${origin}/studio/${projectId}?view=project`, {
    waitUntil: "networkidle",
  });
  await page
    .getByText("只有项目所有者可以管理成员与邀请。", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "创建邀请" }).count(), 0);
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await page
    .getByText("项目级分享由所有者管理。原型版本分享位于“交付”。", {
      exact: true,
    })
    .waitFor();
  assert.equal(ownerReads, beforeReads);
  assert.equal(
    await page.getByRole("button", { name: "创建项目发布" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "取消导出" }).count(), 0);
  results.checks.push(
    "viewer navigation retains permitted read/download actions without querying owner-only invitation/directory/share endpoints or rendering write controls",
  );
  await page.screenshot({
    path: new URL("publishing-viewer.png", output).pathname,
  });
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.unknown, []);
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.failure = error.stack;
  results.url = page.url();
  results.body = (await page.locator("body").innerText()).slice(0, 6000);
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  process.exitCode = 1;
} finally {
  results.commands = commands;
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
