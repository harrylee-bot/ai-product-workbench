import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { chromium, firefox, webkit } from "playwright";
import sharp from "sharp";

import {
  assertRouteTransitionFrames,
  routePresent,
} from "./workbench-route-frame-contract.mjs";

const origin = normalizedOrigin(
  process.env.WORKBENCH_E2E_WEB_ORIGIN ?? "http://localhost:3000",
  "WORKBENCH_E2E_WEB_ORIGIN",
);
const browserName = process.env.WORKBENCH_E2E_BROWSER ?? "chromium";
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported WORKBENCH_E2E_BROWSER: ${browserName}`);
const screenshotSuffix = browserName === "chromium" ? "" : `-${browserName}`;
const timestamp = "2026-07-15T10:00:00.000Z";
const homeHref = `${origin}/?new=1#home`;
const projectHref = `${origin}/projects/p1?old=1&boardNode=n1#canvas`;
const duplicatedProjectHref = `${origin}/projects/p2`;
const boardPath = "/api/v1/projects/p1/board";
const outputDir = fileURLToPath(new URL("../../output/playwright/", import.meta.url));
const rejectedScreenshot = path.join(outputDir, `workbench-navigation-guard-rejected-1501x855${screenshotSuffix}.png`);
const acceptedScreenshot = path.join(outputDir, `workbench-navigation-guard-accepted-1501x855${screenshotSuffix}.png`);
const forwardScreenshot = path.join(outputDir, `workbench-navigation-guard-forward-1501x855${screenshotSuffix}.png`);
const pendingScreenshot = path.join(outputDir, `workbench-navigation-guard-pending-1501x855${screenshotSuffix}.png`);
const unknownRequests = [];
const consoleErrors = [];
const failedBoardSaves = [];
const successfulBoardSaves = [];
let rejectBoardSaves = true;
let projectDuplicated = false;
let releaseNavigationBoardSave;
const navigationBoardSaveGate = new Promise((resolve) => {
  releaseNavigationBoardSave = resolve;
});

const project = {
  id: "p1",
  workspaceId: "workspace-1",
  title: "Navigation Guard Project",
  summary: null,
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const thread = {
  id: "thread-navigation-guard",
  projectId: project.id,
  title: "Navigation Guard Thread",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const duplicatedProject = {
  ...project,
  id: "p2",
  title: "Navigation Guard Project Copy",
};

const duplicatedThread = {
  ...thread,
  id: "thread-navigation-guard-copy",
  projectId: duplicatedProject.id,
  title: "Navigation Guard Copy Thread",
};

let board = {
  id: "board-navigation-guard",
  projectId: project.id,
  revision: 1,
  viewport: { x: 300, y: 90, zoom: 0.63 },
  nodes: [{
    id: "n1",
    kind: "frame",
    parentNodeId: null,
    order: 0,
    position: { x: 120, y: 120 },
    size: { width: 360, height: 260 },
    artifactId: null,
    artifactVersionId: null,
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "frame",
      title: "Navigation Guard Frame",
      fill: null,
      stroke: "#5f6368",
    },
  }],
  edges: [],
};

const duplicatedBoard = {
  id: "board-navigation-guard-copy",
  projectId: duplicatedProject.id,
  revision: 1,
  viewport: { x: 180, y: 70, zoom: 0.82 },
  nodes: [{
    id: "n2",
    kind: "frame",
    parentNodeId: null,
    order: 0,
    position: { x: 640, y: 240 },
    size: { width: 420, height: 300 },
    artifactId: null,
    artifactVersionId: null,
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "frame",
      title: "Navigation Guard Copy Frame",
      fill: null,
      stroke: "#5f6368",
    },
  }],
  edges: [],
};

await mkdir(outputDir, { recursive: true });
const browser = await browserType.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1501, height: 855 } });
  await installAuthenticatedSession(context);
  await context.route("**/api/v1/**", routeWorkbenchApi);

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    const expectedRejectedSave = location.url.includes(boardPath)
      && /503|Service Unavailable/u.test(message.text());
    if (!expectedRejectedSave) {
      consoleErrors.push(`${message.text()} @ ${JSON.stringify(location)}`);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    window.__workbenchE2eNavigationTrace = [];
    window.__workbenchE2eRouteFrames = [];
    let routeCapture = null;
    let routeElementSequence = 0;
    const routeElementIds = new WeakMap();
    const routeRoot = (element) => {
      const stage = document.querySelector("[data-workbench-stage]");
      let current = element;
      while (current?.parentElement && current.parentElement !== stage) {
        current = current.parentElement;
      }
      return current?.parentElement === stage ? current : null;
    };
    const routeSnapshot = (element) => {
      if (!element) return { exists: false };
      if (!routeElementIds.has(element)) {
        routeElementSequence += 1;
        routeElementIds.set(element, routeElementSequence);
      }
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      let ancestor = element;
      let hiddenByAncestor = false;
      while (ancestor) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (ancestorStyle.display === "none" || ancestorStyle.visibility === "hidden") {
          hiddenByAncestor = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      return {
        display: style.display,
        elementId: routeElementIds.get(element),
        exists: true,
        hiddenByAncestor,
        inlineOpacity: element.style.opacity,
        opacity: Number(style.opacity),
        transform: style.transform,
        visibility: style.visibility,
        willChange: style.willChange,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const captureRouteFrame = (timestamp, source) => {
      if (!routeCapture) return;
      const homeHeading = [...document.querySelectorAll("h1,h2,h3")]
        .find((element) => element.textContent?.includes("欢迎使用产品工作台"));
      const home = routeRoot(homeHeading);
      const project = document.querySelector("[data-workbench-project]");
      const stage = document.querySelector("[data-workbench-stage]");
      const frame = {
        elapsedMs: timestamp - routeCapture.startedAt,
        home: routeSnapshot(home),
        homeHeader: routeSnapshot(home?.querySelector("header") ?? null),
        href: window.location.href,
        label: routeCapture.label,
        project: routeSnapshot(project),
        projectHeader: routeSnapshot(project?.querySelector("header") ?? null),
        source,
        stage: routeSnapshot(stage),
      };
      if (source === "mutation") {
        const signature = JSON.stringify([
          frame.home,
          frame.homeHeader,
          frame.project,
          frame.projectHeader,
          frame.stage,
          frame.href,
        ]);
        if (signature === routeCapture.lastMutationSignature) return;
        routeCapture.lastMutationSignature = signature;
      }
      window.__workbenchE2eRouteFrames.push(frame);
      if (window.__workbenchE2eRouteFrames.length > 5_000) {
        window.__workbenchE2eRouteFrames.shift();
      }
    };
    const sampleRouteFrame = (timestamp) => {
      if (!routeCapture) return;
      captureRouteFrame(timestamp, "raf");
      routeCapture.frame = requestAnimationFrame(sampleRouteFrame);
    };
    window.__workbenchE2eStartRouteCapture = (label) => {
      if (routeCapture) {
        cancelAnimationFrame(routeCapture.frame);
        routeCapture.observer.disconnect();
      }
      window.__workbenchE2eRouteFrames = [];
      const observer = new MutationObserver(() => captureRouteFrame(performance.now(), "mutation"));
      observer.observe(document.documentElement, {
        attributeFilter: ["hidden", "style"],
        attributes: true,
        childList: true,
        subtree: true,
      });
      routeCapture = {
        frame: 0,
        label,
        lastMutationSignature: "",
        observer,
        startedAt: performance.now(),
      };
      routeCapture.frame = requestAnimationFrame(sampleRouteFrame);
    };
    window.__workbenchE2eStopRouteCapture = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (routeCapture) cancelAnimationFrame(routeCapture.frame);
        routeCapture?.observer.disconnect();
        routeCapture = null;
        resolve(window.__workbenchE2eRouteFrames);
      }));
    });
    window.addEventListener("popstate", () => {
      window.__workbenchE2eNavigationTrace.push({
        href: window.location.href,
        kind: "popstate",
        marker: window.history.state?.marker ?? null,
      });
    });
    window.addEventListener("workbench:navigation:url-committed", (event) => {
      window.__workbenchE2eNavigationTrace.push({
        href: event.detail?.href ?? window.location.href,
        kind: "committed",
        marker: window.history.state?.marker ?? null,
      });
    });
  });

  await page.goto(homeHref, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /欢迎使用产品工作台/u }).waitFor();
  await page.waitForFunction(() => (
    window.history.state?.__workbenchNavigation?.version === 1
    && window.history.state.__workbenchNavigation.index === 0
  ));
  await assertNextRouteOwner(page, "home", "initial Home route");
  await assertRouteDomOwner(page, "home", "initial Home DOM owner");
  await page.evaluate((href) => {
    window.history.replaceState(
      { ...window.history.state, marker: "home-target" },
      "",
      href,
    );
  }, homeHref);

  await startRouteFrameCapture(page, "home-to-project");
  await page.getByText(project.title, { exact: true }).click();
  await page.waitForFunction(() => (
    window.location.pathname === "/projects/p1"
    && window.history.state?.__workbenchNavigation?.index === 1
  ));
  await assertNextRouteOwner(page, "project", "opened Project route", "p1");
  await assertRouteDomOwner(page, "project", "opened Project DOM owner");
  const homeToProjectFrames = await stopRouteFrameCapture(page);
  const homeToProjectMotion = assertRouteTransitionFrames(
    homeToProjectFrames,
    "home",
    "project",
    "Home-to-Project",
  );
  await page.evaluate((href) => {
    const url = new URL(href);
    window.history.replaceState(
      { ...window.history.state, marker: "committed-project" },
      "",
      `${url.pathname}?old=1#canvas`,
    );
  }, projectHref);

  const node = page.locator('.react-flow__node[data-id="n1"]');
  await node.waitFor();
  await node.click({ position: { x: 120, y: 100 } });
  await waitForSelectedNode(node, page, "initial Board deep-link selection");
  await waitForExactUrl(page, projectHref, "published committed Project URL");
  await assertHistoryState(page, "committed-project", 1, "committed Project entry");

  const initialNodePosition = structuredClone(board.nodes[0].position);
  const nodeBounds = await node.boundingBox();
  assert(nodeBounds, "the selected Board node must have measurable browser geometry");
  await page.mouse.move(nodeBounds.x + nodeBounds.width / 2, nodeBounds.y + nodeBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    nodeBounds.x + nodeBounds.width / 2 + 54,
    nodeBounds.y + nodeBounds.height / 2 + 36,
    { steps: 8 },
  );
  await page.mouse.up();

  await waitForValue(
    () => failedBoardSaves.length >= 1,
    page,
    "dirty Board autosave rejection",
  );
  await page.getByText("项目画布保存失败，本次修改仍保留在本地", { exact: true }).waitFor();
  assert(
    movedFrom(failedBoardSaves[0].body.nodes[0].position, initialNodePosition),
    `the rejected PUT must contain the real dragged node position: ${JSON.stringify(failedBoardSaves[0])}`,
  );

  await startRouteFrameCapture(page, "rejected-project-to-home");
  const rejectedBackNavigation = page.goBack();
  await waitForValue(
    () => failedBoardSaves.length >= 2,
    page,
    "NavigationGuard flush rejection",
  );
  await waitForExactUrl(page, projectHref, "pending save committed Project URL");
  await assertNextRouteOwner(page, "project", "pending save committed Project route", "p1");
  await assertRouteDomOwner(page, "project", "pending save committed Project DOM owner");
  assert(
    await page.locator("[data-workbench-stage]").count() === 1,
    `pending save must retain one Workbench Runtime stage: ${await page.locator("[data-workbench-stage]").count()}`,
  );
  await assertHistoryState(page, "committed-project", 1, "pending save committed Project entry");
  await waitForSelectedNode(node, page, "pending save Board selection");
  const pendingCanvas = page.locator("[data-workbench-project] .react-flow");
  assert(
    await pendingCanvas.count() === 1,
    `pending save must retain exactly one React Flow canvas: ${await pendingCanvas.count()}`,
  );
  const pendingCanvasScreenshot = await pendingCanvas.screenshot({ path: pendingScreenshot });
  const pendingCanvasPixels = await assertNonBlankPixels(
    pendingCanvasScreenshot,
    "pending save React Flow canvas",
  );
  releaseNavigationBoardSave();
  await rejectedBackNavigation;
  await page.getByText(
    "项目画布尚未保存，已取消离开。请重试保存后再操作",
    { exact: true },
  ).waitFor();
  await waitForExactUrl(page, projectHref, "rejected navigation committed URL restore");
  await assertNextRouteOwner(page, "project", "rejected navigation Project route", "p1");
  await assertRouteDomOwner(page, "project", "rejected navigation Project DOM owner");
  await waitForSelectedNode(node, page, "rejected navigation Board selection");
  await assertHistoryState(page, "committed-project", 1, "rejected navigation Project entry");
  const rejectedBackFrames = await stopRouteFrameCapture(page);
  const rejectedBackMotion = assertRejectedBackFrames(rejectedBackFrames);
  await page.screenshot({ path: rejectedScreenshot, fullPage: true });

  rejectBoardSaves = false;
  await startRouteFrameCapture(page, "project-to-home");
  await page.goBack();
  await page.getByRole("heading", { name: /欢迎使用产品工作台/u }).waitFor();
  await assertNextRouteOwner(page, "home", "accepted Home route");
  await assertRouteDomOwner(page, "home", "accepted Home DOM owner");
  await waitForExactUrl(page, homeHref, "accepted Home history target");
  await waitForValue(
    () => successfulBoardSaves.length === 1,
    page,
    "successful NavigationGuard save barrier",
  );
  await assertHistoryState(page, "home-target", 0, "accepted Home target");
  const projectToHomeFrames = await stopRouteFrameCapture(page);
  const projectToHomeMotion = assertRouteTransitionFrames(
    projectToHomeFrames,
    "project",
    "home",
    "Project-to-Home",
  );
  assert(
    board.revision === 2 && movedFrom(board.nodes[0].position, initialNodePosition),
    `the accepted navigation must persist the dirty Board exactly once: ${JSON.stringify(board)}`,
  );
  await page.screenshot({ path: acceptedScreenshot, fullPage: true });

  await startRouteFrameCapture(page, "forward-home-to-project");
  await page.goForward();
  await assertNextRouteOwner(page, "project", "forward Project route", "p1");
  await assertRouteDomOwner(page, "project", "forward Project DOM owner");
  await waitForExactUrl(page, projectHref, "forward Project URL restore");
  await waitForSelectedNode(node, page, "forward Project Board selection");
  await assertHistoryState(page, "committed-project", 1, "forward Project entry");
  const forwardFrames = await stopRouteFrameCapture(page);
  const forwardMotion = assertRouteTransitionFrames(
    forwardFrames,
    "home",
    "project",
    "Forward Home-to-Project",
  );
  await page.screenshot({ path: forwardScreenshot, fullPage: true });

  const repeatedRootCounts = [];
  await page.goBack();
  await assertNextRouteOwner(page, "home", "repeated Home route");
  repeatedRootCounts.push(await assertRouteDomOwner(page, "home", "repeated Home DOM owner"));
  await waitForExactUrl(page, homeHref, "repeated Home URL restore");
  await assertHistoryState(page, "home-target", 0, "repeated Home entry");

  await page.goForward();
  await assertNextRouteOwner(page, "project", "repeated forward Project route", "p1");
  repeatedRootCounts.push(await assertRouteDomOwner(
    page,
    "project",
    "repeated forward Project DOM owner",
  ));
  await waitForExactUrl(page, projectHref, "repeated forward Project URL restore");
  await waitForSelectedNode(node, page, "repeated forward Project Board selection");
  await assertHistoryState(page, "committed-project", 1, "repeated forward Project entry");

  const projectRootBeforeSwitch = await page.locator("[data-workbench-project]").elementHandle();
  const projectHeaderBeforeSwitch = await page.locator("[data-workbench-project] header").first().elementHandle();
  const reactFlowBeforeSwitch = await page.locator("[data-workbench-project] .react-flow").elementHandle();
  assert(projectRootBeforeSwitch, "P1 Project root must exist before the P1-to-P2 switch");
  assert(projectHeaderBeforeSwitch, "P1 Project header must exist before the P1-to-P2 switch");
  assert(reactFlowBeforeSwitch, "P1 React Flow root must exist before the P1-to-P2 switch");

  await page.getByRole("button", { name: "项目菜单" }).click();
  await page.getByRole("menuitem", { name: "复制项目", exact: true }).click();
  await page.waitForFunction((expectedHref) => {
    const state = window.history.state;
    const tree = state?.__PRIVATE_NEXTJS_INTERNALS_TREE?.tree;
    const serializedTree = tree ? JSON.stringify(tree) : "";
    const expectedProjectTuple = JSON.stringify(["projectId", "p2"]).slice(1, -1);
    return window.location.href === expectedHref
      && state?.marker === "committed-project"
      && state?.__workbenchNavigation?.version === 1
      && state.__workbenchNavigation.index === 2
      && serializedTree.includes(expectedProjectTuple);
  }, duplicatedProjectHref);
  await waitForExactUrl(page, duplicatedProjectHref, "P2 Project URL");
  await assertHistoryState(page, "committed-project", 2, "P2 Project entry");
  await page.getByText(duplicatedProject.title, { exact: true }).waitFor();
  const duplicatedNode = page.locator('.react-flow__node[data-id="n2"]');
  await duplicatedNode.waitFor();
  await waitForValue(
    () => page.locator('.react-flow__node[data-id="n1"]').count().then((count) => count === 0),
    page,
    "P2 must not retain the P1 Board node",
  );
  const projectSwitchIdentity = {
    header: await projectHeaderBeforeSwitch.evaluate((element) => (
      element.isConnected
      && element === document.querySelector("[data-workbench-project] header")
    )),
    projectRoot: await projectRootBeforeSwitch.evaluate((element) => (
      element.isConnected
      && element === document.querySelector("[data-workbench-project]")
    )),
    reactFlow: await reactFlowBeforeSwitch.evaluate((element) => (
      element.isConnected
      && element === document.querySelector("[data-workbench-project] .react-flow")
    )),
  };
  assert(
    Object.values(projectSwitchIdentity).every(Boolean),
    `P1-to-P2 must retain the Project, header, and React Flow DOM roots: ${JSON.stringify(projectSwitchIdentity)}`,
  );
  await assertNextRouteOwner(page, "project", "P2 Project route", "p2");
  await assertRouteDomOwner(page, "project", "P2 Project DOM owner");

  assert(
    failedBoardSaves.length === 2,
    `autosave and NavigationGuard flush must each issue one rejected PUT: ${failedBoardSaves.length}`,
  );
  assert(
    successfulBoardSaves.length === 1,
    `the accepted NavigationGuard retry must issue one successful PUT: ${successfulBoardSaves.length}`,
  );
  assert(
    failedBoardSaves[0].idempotencyKey === failedBoardSaves[1].idempotencyKey
      && failedBoardSaves[1].idempotencyKey === successfulBoardSaves[0].idempotencyKey,
    `all save-barrier attempts must replay one retry snapshot: ${JSON.stringify({
      failed: failedBoardSaves.map((save) => save.idempotencyKey),
      successful: successfulBoardSaves.map((save) => save.idempotencyKey),
    })}`,
  );
  assert(
    isDeepStrictEqual(failedBoardSaves[0].body, failedBoardSaves[1].body)
      && isDeepStrictEqual(failedBoardSaves[1].body, successfulBoardSaves[0].body),
    `all save-barrier attempts must replay the exact same Board snapshot body: ${JSON.stringify({
      failed: failedBoardSaves.map((save) => save.body),
      successful: successfulBoardSaves.map((save) => save.body),
    })}`,
  );
  assert(unknownRequests.length === 0, `Unhandled API requests: ${unknownRequests.join(", ")}`);
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join(" | ")}`);

  console.log(JSON.stringify({
    ok: true,
    browser: browserName,
    rejectedBoardSaveCount: failedBoardSaves.length,
    successfulBoardSaveCount: successfulBoardSaves.length,
    finalBoardRevision: board.revision,
    rejectedUrl: projectHref,
    acceptedUrl: homeHref,
    forwardUrl: projectHref,
    historyMarkers: {
      rejected: "committed-project",
      accepted: "home-target",
      forward: "committed-project",
    },
    pendingCanvasPixels,
    projectSwitchIdentity,
    routeMotion: {
      forward: forwardMotion,
      homeToProject: homeToProjectMotion,
      projectToHome: projectToHomeMotion,
      rejectedBack: rejectedBackMotion,
    },
    repeatedRootCounts,
    screenshots: [
      path.relative(fileURLToPath(new URL("../../", import.meta.url)), pendingScreenshot),
      path.relative(fileURLToPath(new URL("../../", import.meta.url)), rejectedScreenshot),
      path.relative(fileURLToPath(new URL("../../", import.meta.url)), acceptedScreenshot),
      path.relative(fileURLToPath(new URL("../../", import.meta.url)), forwardScreenshot),
    ],
  }, null, 2));
} finally {
  releaseNavigationBoardSave();
  await browser.close();
}

async function installAuthenticatedSession(context) {
  await context.addCookies([{
    name: "workbench.session_token",
    value: "navigation-guard-session",
    url: origin,
  }]);
  await context.route("**/api/auth/**", async (route) => {
    await json(route, {
      session: {
        id: "session-navigation-guard",
        token: "navigation-guard-session",
        userId: "principal-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
        ipAddress: null,
        userAgent: "Playwright",
      },
      user: {
        id: "principal-1",
        name: "Navigation Guard Reviewer",
        email: "navigation-guard@example.test",
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

  if (method === "GET" && requestPath === "/api/v1/identity/me") {
    return json(route, {
      id: "principal-1",
      issuer: "https://identity.example.test",
      subject: "navigation-guard-reviewer",
      email: "navigation-guard@example.test",
      displayName: "Navigation Guard Reviewer",
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
      id: "model-navigation-guard",
      displayName: "Navigation Guard Model",
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
      items: [
        { ...project, role: "owner", relationship: "owned" },
        ...(projectDuplicated
          ? [{ ...duplicatedProject, role: "owner", relationship: "owned" }]
          : []),
      ],
      nextCursor: null,
    });
  }
  if (method === "GET" && requestPath === "/api/v1/workspaces/workspace-1/design-systems") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/import-sources") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/bootstrap") {
    return json(route, {
      project,
      access: { role: "owner" },
      threads: [thread],
      selectedThreadId: thread.id,
      entries: [],
      board,
      artifacts: [],
      latestRun: null,
    }, { etag: `"${board.revision}"` });
  }
  if (method === "POST" && requestPath === "/api/v1/projects/p1/duplicate") {
    assert(
      /^[A-Za-z0-9._:-]{8,128}$/u.test(request.headers()["idempotency-key"] ?? ""),
      "Project duplicate must use a valid Idempotency-Key",
    );
    projectDuplicated = true;
    return json(route, {
      sourceProjectId: project.id,
      project: duplicatedProject,
      createdAt: timestamp,
    }, {
      etag: '"1"',
      location: "/api/v1/projects/p2/bootstrap",
    }, 201);
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/bootstrap") {
    return json(route, {
      project: duplicatedProject,
      access: { role: "owner" },
      threads: [duplicatedThread],
      selectedThreadId: duplicatedThread.id,
      entries: [],
      board: duplicatedBoard,
      artifacts: [],
      latestRun: null,
    }, { etag: '"1"' });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/import-sources") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === `/api/v1/threads/${thread.id}/submission-intents/current`) {
    return json(route, { item: null });
  }
  if (method === "GET" && requestPath === `/api/v1/threads/${duplicatedThread.id}/submission-intents/current`) {
    return json(route, { item: null });
  }
  if (method === "GET" && requestPath === boardPath) {
    return json(route, board, { etag: `"${board.revision}"` });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/board") {
    return json(route, duplicatedBoard, { etag: '"1"' });
  }
  if (method === "PUT" && requestPath === boardPath) {
    const ifMatch = request.headers()["if-match"];
    const idempotencyKey = request.headers()["idempotency-key"];
    assert(ifMatch === `"${board.revision}"`, `Board PUT must use strong If-Match: ${ifMatch}`);
    assert(
      /^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey ?? ""),
      `Board PUT must use a valid Idempotency-Key: ${idempotencyKey}`,
    );
    const body = request.postDataJSON();
    if (rejectBoardSaves) {
      failedBoardSaves.push({ body, idempotencyKey, ifMatch });
      if (failedBoardSaves.length === 2) await navigationBoardSaveGate;
      return json(route, {
        type: "about:blank",
        title: "Board save unavailable",
        status: 503,
        code: "BOARD_SAVE_UNAVAILABLE",
        detail: "The E2E fixture is rejecting the Board save barrier",
      }, {}, 503);
    }
    board = {
      id: board.id,
      projectId: board.projectId,
      revision: board.revision + 1,
      ...body,
    };
    successfulBoardSaves.push({
      board: structuredClone(board),
      body: structuredClone(body),
      idempotencyKey,
      ifMatch,
    });
    return json(route, board, { etag: `"${board.revision}"` });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/releases") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/releases") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/members") {
    return json(route, { items: [{
      projectId: project.id,
      principalId: "principal-1",
      role: "owner",
      displayName: "Navigation Guard Reviewer",
      email: "navigation-guard@example.test",
      createdAt: timestamp,
      updatedAt: timestamp,
    }] });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/members") {
    return json(route, { items: [{
      projectId: duplicatedProject.id,
      principalId: "principal-1",
      role: "owner",
      displayName: "Navigation Guard Reviewer",
      email: "navigation-guard@example.test",
      createdAt: timestamp,
      updatedAt: timestamp,
    }] });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/invitations") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/invitations") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/shares") {
    return json(route, { items: [], activeCount: 0, nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/shares") {
    return json(route, { items: [], activeCount: 0, nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p1/exports") {
    return json(route, { items: [], nextCursor: null });
  }
  if (method === "GET" && requestPath === "/api/v1/projects/p2/exports") {
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

  unknownRequests.push(`${method} ${requestPath}`);
  return json(route, {
    type: "about:blank",
    title: "Unhandled browser fixture request",
    status: 404,
    code: "FIXTURE_ROUTE_MISSING",
  }, {}, 404);
}

async function startRouteFrameCapture(page, label) {
  await page.evaluate((captureLabel) => {
    window.__workbenchE2eStartRouteCapture(captureLabel);
  }, label);
}

async function stopRouteFrameCapture(page) {
  return page.evaluate(() => window.__workbenchE2eStopRouteCapture());
}

function assertRejectedBackFrames(frames) {
  assert(frames.length >= 2, `Rejected Back must capture route frames: ${frames.length}`);
  const stageFailures = frames.filter((frame) => !routePresent(frame.stage));
  const homeFrames = frames.filter((frame) => frame.home.exists);
  const projectFailures = frames.filter((frame) => (
    !routePresent(frame.project) || frame.project.opacity < 0.98
  ));
  assert(stageFailures.length === 0, "Rejected Back must never hide the Workbench stage");
  assert(homeFrames.length === 0, "Rejected Back must never mount or flash the Home route");
  assert(projectFailures.length === 0, "Rejected Back must retain the fully visible Project root on every frame");
  return {
    elapsedMs: Math.round(frames.at(-1)?.elapsedMs ?? 0),
    frameCount: frames.length,
    homeFrames: homeFrames.length,
    mutationSamples: frames.filter((frame) => frame.source === "mutation").length,
    rafSamples: frames.filter((frame) => frame.source === "raf").length,
  };
}

async function waitForSelectedNode(locator, page, label) {
  await waitForValue(
    () => locator.evaluate((element) => element.classList.contains("selected")).catch(() => false),
    page,
    label,
  );
}

async function waitForExactUrl(page, expected, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (page.url() === expected) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} did not restore ${expected}: ${JSON.stringify({
    actual: page.url(),
    history: await page.evaluate(() => ({
      length: window.history.length,
      state: window.history.state,
    })),
    navigationTrace: await page.evaluate(() => window.__workbenchE2eNavigationTrace),
    toasts: await page.locator("[data-sonner-toast]").allTextContents(),
  })}`);
}

async function assertHistoryState(page, marker, index, label) {
  const state = await page.evaluate(() => window.history.state);
  assert(
    state?.marker === marker
      && state?.__workbenchNavigation?.version === 1
      && state.__workbenchNavigation.index === index,
    `${label} must preserve marker ${marker} at Workbench history index ${index}: ${JSON.stringify(state)}`,
  );
}

async function assertNextRouteOwner(page, expected, label, expectedProjectId = null) {
  await waitForValue(async () => {
    const owner = await page.evaluate((projectId) => {
      const tree = window.history.state?.__PRIVATE_NEXTJS_INTERNALS_TREE?.tree;
      if (!tree) return "missing";
      const serialized = JSON.stringify(tree);
      if (!serialized.includes('"projectId"')) return "home";
      if (!projectId) return "project";
      const expectedTuple = JSON.stringify(["projectId", projectId]).slice(1, -1);
      return serialized.includes(expectedTuple) ? `project:${projectId}` : "project:other";
    }, expectedProjectId);
    if (expected === "project" && expectedProjectId) {
      return owner === `project:${expectedProjectId}`;
    }
    return owner === expected;
  }, page, label);
}

async function assertRouteDomOwner(page, expected, label) {
  const home = page.getByRole("heading", { name: /欢迎使用产品工作台/u });
  const project = page.locator("[data-workbench-project]");
  const startedAt = Date.now();
  let snapshot;
  while (Date.now() - startedAt < 8_000) {
    const homeCount = await home.count();
    const homeDisplayNone = await displayNoneElementCount(home);
    const projectCount = await project.count();
    const projectDisplayNone = await displayNoneElementCount(project);
    const homeVisible = await visibleElementCount(home);
    const projectVisible = await visibleElementCount(project);
    const stageCount = await page.locator("[data-workbench-stage]").count();
    snapshot = {
      homeCount,
      homeDisplayNone,
      homeVisible,
      projectCount,
      projectDisplayNone,
      projectVisible,
      stageCount,
    };
    const settled = expected === "home"
      ? homeCount === 1
        && homeVisible === 1
        && homeDisplayNone === 0
        && projectCount <= 1
        && projectVisible === 0
        && projectDisplayNone === projectCount
      : projectCount === 1
        && projectVisible === 1
        && projectDisplayNone === 0
        && homeCount <= 1
        && homeVisible === 0
        && homeDisplayNone === homeCount;
    if (settled && stageCount === 1) return snapshot;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} did not settle to one exclusive route root: ${JSON.stringify({
    ...snapshot,
    homeRoots: await routeRootDiagnostics(home),
    navigationTrace: await page.evaluate(() => window.__workbenchE2eNavigationTrace),
    projectRoots: await routeRootDiagnostics(project),
    routeState: await page.evaluate(() => window.history.state),
    url: page.url(),
  })}`);
}

async function routeRootDiagnostics(locator) {
  return locator.evaluateAll((elements) => elements.map((element) => {
    const ancestry = [];
    let current = element;
    while (current && ancestry.length < 8) {
      const style = getComputedStyle(current);
      ancestry.push({
        ariaHidden: current.getAttribute("aria-hidden"),
        className: current.getAttribute("class"),
        display: style.display,
        opacity: style.opacity,
        tag: current.tagName,
        visibility: style.visibility,
      });
      current = current.parentElement;
    }
    return ancestry;
  }));
}

async function visibleElementCount(locator) {
  return locator.evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && bounds.width > 0
      && bounds.height > 0;
  }).length);
}

async function displayNoneElementCount(locator) {
  return locator.evaluateAll((elements) => elements.filter((element) => {
    let current = element;
    while (current) {
      if (getComputedStyle(current).display === "none") return true;
      current = current.parentElement;
    }
    return false;
  }).length);
}

async function assertNonBlankPixels(buffer, label) {
  const stats = await sharp(buffer).stats();
  const rgb = stats.channels.slice(0, 3);
  const maximumDeviation = Math.max(...rgb.map((channel) => channel.stdev));
  const minimumRange = Math.max(...rgb.map((channel) => channel.max - channel.min));
  assert(
    stats.entropy >= 1 && maximumDeviation >= 8 && minimumRange >= 32,
    `${label} must contain rendered UI pixels: ${JSON.stringify({
      entropy: stats.entropy,
      maximumDeviation,
      minimumRange,
    })}`,
  );
  return {
    entropy: Number(stats.entropy.toFixed(3)),
    maximumDeviation: Number(maximumDeviation.toFixed(3)),
    minimumRange,
  };
}

function movedFrom(actual, initial) {
  return actual.x !== initial.x || actual.y !== initial.y;
}

async function waitForValue(predicate, page, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    if (await predicate()) return;
    await page.waitForTimeout(50);
  }
  assert(await predicate(), `${label} did not reach the expected state`);
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
