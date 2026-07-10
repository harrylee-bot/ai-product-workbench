import assert from "node:assert/strict";
import { mkdir as fsMkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const finalizer = path.resolve("apps/knowledge/finalize-output.mjs");

test("injects the base path and fingerprints shared assets idempotently", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "knowledge-finalizer-"));
  try {
    await writeFile(path.join(outputRoot, "index.css"), "body { color: black; }\n");
    await writeFile(path.join(outputRoot, "prescript.js"), "window.before = true;\n");
    await writeFile(path.join(outputRoot, "postscript.js"), "window.after = true;\n");
    await fsMkdir(path.join(outputRoot, "static"));
    await writeFile(path.join(outputRoot, "static", "icon.png"), Buffer.alloc(2048, 1));
    await writeFile(path.join(outputRoot, "static", "og-image.png"), Buffer.alloc(4096, 2));
    await writeFile(
      path.join(outputRoot, "index.html"),
      '<html><head><meta name="og:site_name" content="策划宝产品知识库"/><meta property="twitter:domain" content="aionbench.com/knowledge"/><meta property="og:url" content="https://aionbench.com/knowledge/index"/><meta property="twitter:url" content="https://aionbench.com/knowledge/index"/><meta property="og:image:type" content="image/.png"/><link rel="icon" href="./static/icon.png"><meta property="og:image" content="https://aionbench.com/knowledge/static/og-image.png"><link href="./index.css"><script src="./prescript.js"></script></head><body><script src="./postscript.js"></script></body></html>',
    );
    await writeFile(
      path.join(outputRoot, "redirect.html"),
      '<!doctype html><link href="./index.css"><script src="./prescript.js"></script>',
    );

    const first = runFinalizer(outputRoot);
    assert.equal(first.status, 0, first.stderr);
    const firstReport = JSON.parse(first.stdout.trim());
    assert.equal(firstReport.basePath, "/knowledge");
    assert.equal(firstReport.redirects, 1);
    assert.equal(firstReport.assets.length, 5);

    const names = await readdir(outputRoot);
    assert.equal(names.includes("index.css"), false);
    assert.equal(names.includes("prescript.js"), false);
    assert.equal(names.includes("postscript.js"), false);
    for (const asset of firstReport.assets) {
      const entries = await readdir(path.join(outputRoot, path.dirname(asset.target)));
      assert.equal(entries.includes(path.basename(asset.target)), true);
    }

    const page = await readFile(path.join(outputRoot, "index.html"), "utf8");
    assert.match(page, /<body data-basepath="\/knowledge">/);
    assert.match(page, /<meta property="og:site_name"/);
    assert.match(page, /<meta name="twitter:domain" content="aionbench\.com"\/>/);
    assert.match(page, /<meta property="og:image:type" content="image\/png"\/>/);
    assert.match(page, /<meta property="og:url" content="https:\/\/aionbench\.com\/knowledge\/"\/>/);
    assert.match(page, /<link rel="canonical" href="https:\/\/aionbench\.com\/knowledge\/"\/>/);
    for (const asset of firstReport.assets) {
      assert.equal(page.includes(asset.source), false);
      assert.equal(page.includes(asset.target), true);
    }

    const redirect = await readFile(path.join(outputRoot, "redirect.html"), "utf8");
    assert.equal(redirect.includes("data-basepath"), false);
    assert.equal(redirect.includes(firstReport.assets[0].target), true);

    const second = runFinalizer(outputRoot);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout.trim()).assets, firstReport.assets);
    assert.equal(await readFile(path.join(outputRoot, "index.html"), "utf8"), page);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

function runFinalizer(outputRoot) {
  return spawnSync(process.execPath, [finalizer, outputRoot, "aionbench.com/knowledge"], {
    encoding: "utf8",
  });
}
