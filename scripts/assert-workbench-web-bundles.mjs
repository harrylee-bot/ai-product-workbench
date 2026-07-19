#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const nextRoot = path.join(root, "apps/web/.next");
const chunksRoot = path.join(nextRoot, "static/chunks");
const cssRoot = path.join(nextRoot, "static/css");
const homeHtmlPath = path.join(nextRoot, "server/app/index.html");

assert(existsSync(homeHtmlPath), "Build apps/web before checking Workbench route bundles");
const homeHtml = readFileSync(homeHtmlPath, "utf8");
const initialAssets = new Set(
  [...homeHtml.matchAll(/\/_next\/(static\/(?:chunks|css)\/[^" ]+\.(?:css|js))/gu)]
    .map((match) => match[1]),
);
const jsFiles = readdirSync(chunksRoot).filter((file) => file.endsWith(".js"));
const cssFiles = readdirSync(cssRoot).filter((file) => file.endsWith(".css"));
const projectCssFiles = cssFiles.filter((file) => {
  const source = readFileSync(path.join(cssRoot, file), "utf8");
  return source.includes(".react-flow__") && source.includes(".workbench-prd-editor-content");
});
assert(projectCssFiles.length === 1, `Expected one Project CSS chunk, found ${projectCssFiles.length}`);
const projectCssAsset = `static/css/${projectCssFiles[0]}`;
assert(!initialAssets.has(projectCssAsset), "Cold Home must not request Project CSS");

// Next 16 emits the CSS loader in the webpack runtime rather than a standalone
// route loader. Keep the assertion tied to the emitted dynamic CSS edge.
const loaderFiles = jsFiles
  .filter((file) => readFileSync(path.join(chunksRoot, file), "utf8").includes(projectCssAsset));
assert(loaderFiles.length >= 1, "Expected a Project dynamic loader to reference scoped CSS");

const projectChunks = jsFiles
  .filter((file) => {
    const source = readFileSync(path.join(chunksRoot, file), "utf8");
    return source.includes("workbench-project")
      || source.includes("react-flow")
      || source.includes("Moveable")
      || source.includes("ProseMirror");
  })
  .map((file) => `static/chunks/${file}`);
assert(projectChunks.length >= 2, "Expected Project-only React Flow and editor runtime chunks");
for (const asset of projectChunks) {
  assert(!initialAssets.has(asset), `Cold Home must not request Project chunk ${asset}`);
}
const projectAssets = new Set([...projectChunks, projectCssAsset]);

const homeJsBytes = bytes(initialAssets, ".js");
const homeCssBytes = bytes(initialAssets, ".css");
const projectAdditionalJsBytes = bytes(projectAssets, ".js");
const projectAdditionalCssBytes = bytes(projectAssets, ".css");

console.log(JSON.stringify({
  ok: true,
  emittedBytes: {
    homeCss: homeCssBytes,
    homeJs: homeJsBytes,
    projectAdditionalCss: projectAdditionalCssBytes,
    projectAdditionalJs: projectAdditionalJsBytes,
    projectTotalCss: homeCssBytes + projectAdditionalCssBytes,
    projectTotalJs: homeJsBytes + projectAdditionalJsBytes,
  },
  projectChunks: projectChunks.map((asset) => ({ asset, bytes: assetSize(asset) })),
  projectCss: { asset: projectCssAsset, bytes: assetSize(projectCssAsset) },
}, null, 2));

function bytes(assets, extension) {
  return [...assets]
    .filter((asset) => asset.endsWith(extension))
    .reduce((total, asset) => total + assetSize(asset), 0);
}

function assetSize(asset) {
  return statSync(path.join(nextRoot, asset)).size;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
