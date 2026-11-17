// Anonymous new-frontend regression using controlled HTTP responses, not live share acceptance.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  prototypePublicShareSchema,
  publicShareSchema,
} from "@workbench/workbench-contracts";
const origin = process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://127.0.0.1:18930";
const output = new URL(
  process.env.WORKBENCH_E2E_STUDIO_OUTPUT ?? "../../output/audit/1.0.0/studio-public/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const now = "2026-11-16T00:00:00Z",
  token = `wbp2_${"a".repeat(43)}`,
  projectToken = `wbs_${"b".repeat(43)}`;
const pages = [
  { id: "one", slug: "one", title: "订阅", route: "/", order: 0 },
  { id: "two", slug: "two", title: "完成", route: "/done", order: 1 },
];
const html = `<!doctype html><html><body><main data-wb-screen="one"><h1>公开订阅原型</h1><input aria-label="邮箱"/><button onclick="document.getElementById('status').textContent='已提交'">提交订阅</button><p id="status">待提交</p></main><main data-wb-screen="two" hidden><h1>公开完成页面</h1></main><script>document.addEventListener('workbench:prototype-select-page', event => { document.querySelectorAll('[data-wb-screen]').forEach(page => page.hidden = page.dataset.wbScreen !== event.detail.pageId); document.dispatchEvent(new CustomEvent('workbench:prototype-page', {detail:event.detail})); });</script></body></html>`;
for (const page of pages) {
  page.content = html.match(
    new RegExp(`<main data-wb-screen="${page.id}"[^>]*>[\\s\\S]*?<\\/main>`),
  )[0];
  page.sha256 = createHash("sha256").update(page.content).digest("hex");
}
const prototype = {
  share: {
    id: "share-one",
    projectId: "project-one",
    revisionId: "revision-one",
    revision: 1,
    status: "active",
    url: `${origin}/prototype-share/${token}`,
    expiresAt: null,
    createdAt: now,
    revokedAt: null,
  },
  revision: {
    id: "revision-one",
    projectId: "project-one",
    planId: "plan-one",
    version: 1,
    sourceRevisionId: null,
    revision: 1,
    status: "ready",
    title: "共享订阅",
    pages,
    previewHtml: html,
    documentSha256: "a".repeat(64),
    createdAt: now,
    updatedAt: now,
    failure: null,
  },
};
const board = {
  id: "board-one",
  projectId: "project-one",
  revision: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
};
const projectShare = {
  shareId: "project-share",
  scope: "view",
  expiresAt: null,
  release: {
    id: "release-one",
    projectId: "project-one",
    version: 1,
    status: "ready",
    boardId: board.id,
    boardRevision: 1,
    boardSnapshot: board,
    boardChecksum: "a".repeat(64),
    artifactPins: [],
    manifest: {
      protocol: "workbench.project-release.v1",
      projectId: "project-one",
      releaseVersion: 1,
      board: { id: board.id, revision: 1, checksum: "a".repeat(64) },
      artifacts: [],
    },
    manifestSha256: "b".repeat(64),
    failure: null,
    createdAt: now,
    finishedAt: now,
    updatedAt: now,
  },
};
const results = {
  evidence:
    "anonymous browser with controlled public responses; not a deployed share test",
  checks: [],
  errors: [],
  consoleErrors: [],
  privateRequests: [],
};
prototypePublicShareSchema.parse(prototype);
publicShareSchema.parse(projectShare);
let state = "active",
  kind = "prototype",
  reads = 0;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const json = (route, value, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { etag: `"${"a".repeat(64)}"` },
    body: JSON.stringify(value),
  });
await context.route("**/api/auth/**", (route) => json(route, null));
await context.route("**/api/v1/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (!path.startsWith("/api/v1/public/")) {
    results.privateRequests.push(path);
    return json(route, { status: 403 }, 403);
  }
  reads++;
  if (state === "active" || state === "empty")
    return json(
      route,
      kind === "project"
        ? projectShare
        : {
            ...prototype,
            revision: {
              ...prototype.revision,
              previewHtml: state === "empty" ? null : html,
            },
          },
    );
  const statuses = {
    revoked: [404, "SHARE_REVOKED"],
    expired: [404, "SHARE_EXPIRED"],
    invalid: [404, "RESOURCE_NOT_FOUND"],
    preview: [409, "SHARE_PREVIEW_UNAVAILABLE"],
    failed: [503, "UPSTREAM_FAILED"],
  };
  const [status, code] = statuses[state];
  return json(
    route,
    {
      type: "about:blank",
      title: "private diagnostic",
      status,
      code,
      detail: "/private/bucket/internal-object",
    },
    status,
  );
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.setDefaultNavigationTimeout(60000);
page.on("pageerror", (error) => results.errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") results.consoleErrors.push(message.text());
});
try {
  await page.goto(`${origin}/prototype-share/${token}`, {
    waitUntil: "networkidle",
  });
  const frame = page.frameLocator("iframe");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(
      () => document.querySelector(".studio-onlook-canvas")?.clientHeight > 300,
    );
    const bounds = await page.locator("iframe").boundingBox();
    assert(
      bounds &&
        bounds.width > 200 &&
        bounds.height > 100 &&
        bounds.y >= 0 &&
        bounds.y < viewport.height,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({ path: new URL("active.png", output).pathname });
  await frame
    .getByRole("textbox", { name: "邮箱" })
    .fill("anonymous@example.test");
  const submit = frame.getByRole("button", { name: "提交订阅" });
  await submit.evaluate(async (element) => {
    element.scrollIntoView({ block: "center" });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  const local = await submit.evaluate((element) =>
    element.getBoundingClientRect().toJSON(),
  );
  const outer = await page.locator("iframe").boundingBox();
  const width = await page
    .locator("iframe")
    .evaluate((element) => element.clientWidth);
  const ratio = outer.width / width;
  // Chromium's nested-frame locator coordinates omit the parent canvas transform.
  // Send a physical pointer event at the measured, scaled button center.
  await page.mouse.click(
    outer.x + (local.x + local.width / 2) * ratio,
    outer.y + (local.y + local.height / 2) * ratio,
  );
  await frame.getByText("已提交", { exact: true }).waitFor();
  await page.getByRole("combobox", { name: "当前页面" }).selectOption("two");
  await frame.getByRole("heading", { name: "公开完成页面" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("page"), "two");
  assert.equal(
    await page.getByRole("textbox", { name: "描述需求或修改" }).count(),
    0,
  );
  results.checks.push(
    "anonymous prototype supports input, button behavior and page navigation without private controls or private API requests",
  );
  state = "revoked";
  await page.getByRole("heading", { name: "分享已撤销" }).waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(await page.getByText("共享订阅", { exact: true }).count(), 0);
  assert(!(await page.locator("body").innerText()).includes("/private/"));
  results.checks.push(
    "a revocation response immediately unmounts the cached prototype iframe and only displays controlled public status",
  );
  for (const [next, heading] of [
    ["expired", "分享已过期"],
    ["invalid", "分享链接无效"],
    ["preview", "暂无可用预览"],
    ["empty", "暂无可用预览"],
    ["failed", "分享加载失败"],
  ]) {
    state = next;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    assert.equal(await page.locator("iframe").count(), 0);
    assert(!(await page.locator("body").innerText()).includes("/private/"));
  }
  state = "active";
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.locator("iframe").waitFor();
  results.checks.push(
    "expired, invalid, missing preview, absent preview bytes and transient load failure remain distinct; retry restores the actual public preview",
  );
  kind = "project";
  state = "active";
  const before = reads;
  await page.goto(`${origin}/share/${projectToken}`, {
    waitUntil: "networkidle",
  });
  await page.getByText("共享项目 · 发布 1", { exact: true }).waitFor();
  state = "expired";
  await page
    .getByRole("heading", { name: "分享已过期", exact: true })
    .waitFor();
  assert(reads >= before + 2);
  assert.equal(
    await page.getByText("共享项目 · 发布 1", { exact: true }).count(),
    0,
  );
  results.checks.push(
    "project shares also revalidate their public capability and remove cached release content when the link expires",
  );
  assert.deepEqual(results.privateRequests, []);
  assert.deepEqual(results.errors, []);
  await page.screenshot({ path: new URL("expired.png", output).pathname });
  const readsBeforeOldLink = reads;
  await page.goto(`${origin}/share?token=${projectToken}`, { waitUntil: "networkidle" });
  await page.getByText("无效的分享链接", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/share");
  assert.equal(reads, readsBeforeOldLink, "Old query token must not load a public release");
  results.checks.push("Legacy /share?token= entry no longer redirects or consumes a token; current path-based shares retain their business behavior");
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.failure = error.stack;
  results.body = (await page.locator("body").innerText()).slice(0, 4000);
  results.layout = await page
    .locator(
      ".visual-workspace, .visual-stage, .visual-stage-body, .visual-viewport, .studio-onlook-canvas, iframe",
    )
    .evaluateAll((elements) =>
      elements.map((element) => ({
        className: element.className,
        rect: element.getBoundingClientRect().toJSON(),
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility,
        ancestors: Array.from(
          (function* (current) {
            while (current) {
              yield current;
              current = current.parentElement;
            }
          })(element.parentElement),
        ).map((parent) => ({
          tag: parent.tagName,
          className: parent.className,
          rect: parent.getBoundingClientRect().toJSON(),
          display: getComputedStyle(parent).display,
          visibility: getComputedStyle(parent).visibility,
        })),
      })),
    );
  await page.screenshot({ path: new URL("failure.png", output).pathname });
  process.exitCode = 1;
} finally {
  results.reads = reads;
  await writeFile(
    new URL("results.json", output),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
