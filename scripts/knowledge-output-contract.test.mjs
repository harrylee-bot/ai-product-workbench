import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const assertionScript = path.resolve("scripts/assert-knowledge-output.mjs");

test("accepts a clean, fingerprinted knowledge build", async () => {
  const fixture = await createFixture({
    host: "aionbench.com",
    canonical: "https://aionbench.com/knowledge/",
    basePath: "/knowledge",
  });
  try {
    const result = runAssertion(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("derives metadata expectations from a local or preview base URL", async () => {
  const fixture = await createFixture({
    host: "localhost",
    canonical: "https://localhost:3001/",
    basePath: "",
  });
  try {
    const result = runAssertion(fixture, "localhost:3001");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects local-only content and duplicate folder listings", async () => {
  const fixture = await createFixture({
    host: "aionbench.com",
    canonical: "https://aionbench.com/knowledge/",
    basePath: "/knowledge",
  });
  try {
    await mkdir(path.join(fixture, "99-收件箱"));
    await writeFile(path.join(fixture, "99-收件箱", "index.html"), "private");
    const requiredFolder = path.join(fixture, "07-来源资产索引", "index.html");
    const folderHtml = await readFile(requiredFolder, "utf8");
    await writeFile(requiredFolder, folderHtml.replace(
      '<div class="page-listing"></div>',
      '<div class="page-listing"></div><div class="page-listing"></div>',
    ));

    const result = runAssertion(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Forbidden local-only path was published/);
    assert.match(result.stderr, /Required folder page must render exactly one listing, found 2/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function createFixture({ host, canonical, basePath }) {
  const fixture = await mkdtemp(path.join(tmpdir(), "knowledge-output-contract-"));
  await mkdir(path.join(fixture, "static"));
  await mkdir(path.join(fixture, "07-来源资产索引"));
  const assetContents = {
    "index.css": Buffer.from("body{}"),
    "prescript.js": Buffer.from("void 0;"),
    "postscript.js": Buffer.from("void 0;"),
    "static/icon.png": Buffer.alloc(2048, 1),
    "static/og-image.png": Buffer.alloc(2048, 2),
  };
  const fingerprinted = Object.fromEntries(Object.entries(assetContents).map(([asset, content]) => {
    const parsed = path.parse(path.basename(asset));
    const fingerprint = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const fileName = `${parsed.name}.${fingerprint}${parsed.ext}`;
    return [asset, path.posix.join(path.dirname(asset) === "." ? "" : path.dirname(asset), fileName)];
  }));
  const pageHtml = `<html><head><title>策划宝产品知识库</title><meta property="og:site_name" content="策划宝产品知识库"><meta name="twitter:domain" content="${host}"/><meta property="og:image:type" content="image/png"/><link rel="canonical" href="${canonical}"/><link rel="icon" href="${fingerprinted["static/icon.png"]}"><meta property="og:image" content="https://aionbench.com/knowledge/${fingerprinted["static/og-image.png"]}"><link href="${fingerprinted["index.css"]}"><script src="${fingerprinted["prescript.js"]}"></script></head><body data-basepath="${basePath}"><script src="${fingerprinted["postscript.js"]}"></script></body></html>`;
  await writeFile(
    path.join(fixture, "index.html"),
    pageHtml,
  );
  await writeFile(
    path.join(fixture, "07-来源资产索引", "index.html"),
    pageHtml.replace("</body>", '<div class="page-listing"></div></body>'),
  );
  for (const [asset, content] of Object.entries(assetContents)) {
    await writeFile(path.join(fixture, fingerprinted[asset]), content);
  }
  await writeFile(path.join(fixture, "static", "contentIndex.json"), "{}");
  await writeFile(path.join(fixture, "sitemap.xml"), "<urlset></urlset>");
  return fixture;
}

function runAssertion(fixture, baseUrl = "aionbench.com/knowledge") {
  return spawnSync(process.execPath, [assertionScript, fixture, baseUrl], {
    encoding: "utf8",
  });
}
