import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { chromium, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { buildFrozenPrototypeHtml } from "@workbench/workbench-build-worker";
import { prototypeDocumentReactOutput, renderPrototypeDocumentHtml, renderPrototypePagesHtml, type ExportBinaryAsset } from "@workbench/workbench-export-core";
import { interactivePrototypeFixture } from "../../../packages/workbench-export-core/test/fixtures.js";
import { prototypeDocumentToPages } from "../src/prototypes/prototype-pages.js";

const executablePath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH ?? chromium.executablePath();
const hasBrowser = existsSync(executablePath);
const execute = promisify(execFile);

function fixture() {
  const document = interactivePrototypeFixture();
  const icon = document.nodes.find(node => node.kind === "icon")!;
  if (icon.kind !== "icon") throw new Error("fixture icon missing");
  const { kind: _kind, assetId: _assetId, accessibilityLabel: _label, ...base } = icon;
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const asset: ExportBinaryAsset = { assetId: "image-pixel", kind: "image", blobId: "blob-pixel", mediaType: "image/png", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  document.assets.push({ id: asset.assetId, kind: "image", name: "Pixel", blobId: asset.blobId, mediaType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, width: 1, height: 1 });
  document.nodes.push({ ...base, id: "node-pixel", kind: "image", assetId: asset.assetId, fit: "contain", alt: "Pixel" });
  const parent = document.nodes.find(node => node.id === base.parentId);
  if (!parent || !("childIds" in parent)) throw new Error("fixture parent missing");
  parent.childIds.push("node-pixel");
  return { document, assets: [asset] };
}

function multipageFixture(pageCount: number) {
  const result = fixture();
  const baseRoot = result.document.nodes.find(node => node.id === "root-success");
  const baseText = result.document.nodes.find(node => node.id === "text-literal");
  if (baseRoot?.kind !== "frame" || baseText?.kind !== "text") throw new Error("multipage fixture unavailable");
  for (let index = 2; index < pageCount; index += 1) {
    const screenId = `screen-extra-${index}`;
    const rootId = `root-extra-${index}`;
    const childIds = Array.from({ length: 9 }, (_, offset) => `text-extra-${index}-${offset}`);
    result.document.screens.push({ id: screenId, name: `Page ${index + 1}`, route: `/page-${index + 1}`, rootNodeId: rootId, initialStateId: null, viewport: { width: 390, height: 680 } });
    result.document.nodes.push({ ...structuredClone(baseRoot), id: rootId, screenId, childIds });
    for (const [offset, id] of childIds.entries()) {
      result.document.nodes.push({ ...structuredClone(baseText), id, screenId, parentId: rootId, text: `Page ${index + 1} item ${offset + 1}`, actionIds: [], bindingIds: [], motionIds: [], layout: { ...structuredClone(baseText.layout), y: { kind: "literal", value: offset * 40 } } });
    }
  }
  return result;
}

async function interact(page: Page) {
  await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("initial@example.test");
  await page.locator('[data-wb-node="button-click"]').click();
  await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Ready");
  await page.locator('[data-wb-node="input-email"]').fill("v2@example.test");
  await expect.poll(() => page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("v2@example.test");
  await page.locator('[data-wb-node="input-plan"]').selectOption("basic");
  expect(await page.locator('[data-wb-node="input-plan"]').inputValue()).toBe("basic");
  await page.locator('[data-wb-node="input-terms"]').check();
  await page.locator('[data-wb-node="button-submit"]').click();
  await expect.poll(() => page.locator('[data-wb-node="text-state"]').textContent()).toBe("Submitted");
  await page.locator('[data-wb-node="button-navigate"]').click();
  await expect.poll(() => page.locator('[data-wb-screen="screen-success"]').isVisible()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("workbench:prototype-select-page", { detail: { pageId: "screen-home" } })));
  await expect.poll(() => page.locator('[data-wb-screen="screen-home"]').isVisible()).toBe(true);
  expect(await page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("v2@example.test");
  expect(await page.locator('[data-wb-node="icon-heart"] svg').count()).toBe(1);
  expect(await page.locator('[data-wb-node="node-pixel"]').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
}

describe("V2 shared executable projection", () => {
  it("stores only each page's DOM and requires the shared source for executable preview", () => {
    const { document, assets } = fixture();
    const pages = prototypeDocumentToPages(document, assets);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.content).not.toContain('id="workbench-export-data"');
    expect(pages[0]!.content).toContain('data-wb-screen="screen-home"');
    expect(pages[0]!.content).not.toContain('data-wb-screen="screen-success"');
    expect(pages[1]!.content).toContain('data-wb-screen="screen-success"');
    expect(pages[1]!.content).not.toContain('data-wb-screen="screen-home"');
    expect(() => prototypeDocumentToPages(document)).toThrow("missing or changed");
    expect(() => renderPrototypePagesHtml("revision-1", "Demo", [{ ...pages[0]!, content: "changed" }])).toThrow("PROTOTYPE_PAGE_INTEGRITY_FAILURE");
    expect(() => renderPrototypePagesHtml("revision-1", "Demo", pages)).toThrow("PROTOTYPE_SHARED_DOCUMENT_REQUIRED");
    expect(() => renderPrototypePagesHtml("revision-1", "Demo", [{ ...pages[0]!, title: "Changed" }, pages[1]!], { document, assets })).toThrow("PROTOTYPE_PAGE_SOURCE_MISMATCH");
  });

  it("keeps 20 and 50 page projections proportional to their DOM instead of copying the full runtime per page", () => {
    const measurements = [20, 50].map(pageCount => {
      const { document, assets } = multipageFixture(pageCount);
      const pages = prototypeDocumentToPages(document, assets);
      const html = renderPrototypePagesHtml("revision-many", document.title, pages, { document, assets });
      const pagesBytes = Buffer.byteLength(JSON.stringify(pages));
      const htmlBytes = Buffer.byteLength(html);
      expect(pages).toHaveLength(pageCount);
      expect(pagesBytes).toBeLessThan(htmlBytes);
      expect(html.match(/id="workbench-export-data"/gu)).toHaveLength(1);
      expect(html.match(/class="wb-screen"/gu)).toHaveLength(pageCount);
      for (const page of pages) {
        expect(page.content.match(/data-wb-screen=/gu)).toHaveLength(1);
        expect(page.content).not.toContain("workbench.export-runtime.v1");
      }
      return { pageCount, nodeCount: document.nodes.length, pagesBytes, sharedHtmlBytes: htmlBytes, priorDuplicatedMinimumBytes: htmlBytes * pageCount };
    });
    expect(measurements[1]!.pagesBytes / measurements[0]!.pagesBytes).toBeLessThan(3);
    expect(measurements[1]!.sharedHtmlBytes / measurements[0]!.sharedHtmlBytes).toBeLessThan(3);
    console.info("V2 shared preview sizes", JSON.stringify(measurements));
  });

  it.runIf(hasBrowser)("executes generated page, frozen HTML and compiled React with the same behavior", async () => {
    const { document, assets } = fixture();
    const pages = prototypeDocumentToPages(document, assets);
    const built = await buildFrozenPrototypeHtml("revision-1", "Demo", pages, { chromiumExecutablePath: executablePath, sourceDocument: document, assets });
    const react = await prototypeDocumentReactOutput(document, { revisionId: "revision-1", assets });
    const archive = unzipSync(react.bytes);
    expect(new TextDecoder().decode(archive["src/App.jsx"])).not.toContain("<iframe");
    expect(JSON.parse(new TextDecoder().decode(archive["package.json"])).devDependencies.vite).toBe("8.1.6");
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      for (const html of [renderPrototypeDocumentHtml(document, { assets }).document, built.html, new TextDecoder().decode(archive["dist/index.html"])]) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
        const errors: string[] = []; const external: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => { if (/^https?:/u.test(request.url())) external.push(request.url()); });
        await page.setContent(html, { waitUntil: "load" });
        await interact(page);
        expect(errors).toEqual([]); expect(external).toEqual([]);
        await page.close();
      }
    } finally { await browser.close(); }
  }, 60_000);

  it.runIf(hasBrowser)("navigates a frozen 50-page document without losing interactive state", async () => {
    const { document, assets } = multipageFixture(50);
    const pages = prototypeDocumentToPages(document, assets);
    const built = await buildFrozenPrototypeHtml("revision-many", document.title, pages, { chromiumExecutablePath: executablePath, sourceDocument: document, assets });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
      await page.goto(`data:text/html;base64,${Buffer.from(built.html).toString("base64")}`);
      await interact(page);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("workbench:prototype-select-page", { detail: { pageId: "screen-extra-49" } })));
      await expect.poll(() => page.locator('[data-wb-screen="screen-extra-49"]').isVisible()).toBe(true);
      expect(await page.locator('[data-wb-node="text-extra-49-8"]').textContent()).toBe("Page 50 item 9");
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("workbench:prototype-select-page", { detail: { pageId: "screen-home" } })));
      await expect.poll(() => page.locator('[data-wb-screen="screen-home"]').isVisible()).toBe(true);
      expect(await page.locator('[data-wb-node="text-mirror"]').textContent()).toBe("v2@example.test");
      expect(await page.locator('[data-wb-node="text-state"]').textContent()).toBe("Submitted");
    } finally { await browser.close(); }
  }, 60_000);

  it.runIf(hasBrowser)("executes explicit HTML page scripts in an opaque sandbox after page selection", async () => {
    const pages = ["one", "two"].map((id, order) => {
      const content = `<button id="change">Change</button><p id="value">${id}</p><script>document.querySelector('#change').onclick=()=>document.querySelector('#value').textContent='changed-${id}'</script>`;
      return { id, title: id, slug: id, route: `/${id}`, order, content, sha256: createHash("sha256").update(content).digest("hex") };
    });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`data:text/html;base64,${Buffer.from(renderPrototypePagesHtml("revision-html", "HTML", pages)).toString("base64")}`);
      await page.frameLocator("iframe").locator("#change").click();
      expect(await page.frameLocator("iframe").locator("#value").textContent()).toBe("changed-one");
      await page.locator('[data-page-id="two"]').click();
      await page.frameLocator("iframe").locator("#change").click();
      expect(await page.frameLocator("iframe").locator("#value").textContent()).toBe("changed-two");
      expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    } finally { await browser.close(); }
  });

  it.runIf(hasBrowser && process.env.WORKBENCH_REACT_EXPORT_INSTALL_TEST === "1")("rebuilds the extracted React source with npm and executes the resulting application", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbench-v2-react-"));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const { document, assets } = fixture();
      const output = await prototypeDocumentReactOutput(document, { assets });
      for (const [name, bytes] of Object.entries(unzipSync(output.bytes))) {
        if (name.startsWith("dist/")) continue;
        await mkdir(dirname(join(directory, name)), { recursive: true });
        await writeFile(join(directory, name), bytes);
      }
      const npm = async (args: string[]) => {
        const cli = process.env.WORKBENCH_REACT_EXPORT_NPM_CLI;
        if (cli) return execute(process.execPath, [cli, ...args], { cwd: directory, timeout: 300_000, killSignal: "SIGKILL" });
        const image = process.env.WORKBENCH_REACT_EXPORT_NODE_IMAGE;
        if (!image) return execute("npm", args, { cwd: directory, timeout: 300_000, killSignal: "SIGKILL" });
        const name = `workbench-v2-react-${randomUUID()}`;
        const cache = process.env.WORKBENCH_REACT_EXPORT_NPM_CACHE;
        try {
          return await execute("docker", ["run", "--rm", "--name", name, "--mount", `type=bind,source=${directory},target=/app`, ...(cache ? ["--mount", `type=bind,source=${cache},target=/root/.npm/_cacache`] : []), "--workdir", "/app", image, "npm", ...args], { timeout: 300_000, killSignal: "SIGKILL" });
        } finally { await execute("docker", ["rm", "--force", name]).catch(() => undefined); }
      };
      await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", ...(process.env.WORKBENCH_REACT_EXPORT_NPM_OFFLINE === "1" ? ["--offline"] : [])]);
      await npm(["run", "build", "--", "--base=./"]);
      const html = await readFile(join(directory, "dist/index.html"), "utf8");
      expect(html).toContain("assets/");
      // Serve the real Vite build: module scripts cannot load over file://.
      const { createServer } = await import("node:http");
      const server = createServer(async (request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const file = join(directory, "dist", path === "/" ? "index.html" : path);
        try {
          response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
          response.end(await readFile(file));
        } catch { response.writeHead(404).end(); }
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address(); if (!address || typeof address === "string") throw new Error("server unavailable");
        const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
        await page.goto(`http://127.0.0.1:${address.port}`);
        await interact(page);
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
  }, 600_000);
});
