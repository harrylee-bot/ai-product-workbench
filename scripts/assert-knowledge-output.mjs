#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve(process.argv[2] || process.env.QUARTZ_OUTPUT_DIR || "public");
const configuredBaseUrl = process.argv[3] || process.env.QUARTZ_BASE_URL || "";
const basePath = normalizeBasePath(configuredBaseUrl);
const publicHost = resolvePublicHost(configuredBaseUrl);
const canonicalRoot = resolveCanonicalRoot(configuredBaseUrl);
const expectedBrand = "策划宝产品知识库";
const forbiddenPublicSegments = ["_templates", "99-收件箱"];
const legacyBrands = ["业务需求知识库", "AI Product OS 知识库"];
const errors = [];

const files = await collectFiles(outputRoot);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const bodyPages = [];
let redirects = 0;
let requiredFolderListings = 0;

if (!htmlFiles.length) errors.push(`No generated HTML found under ${outputRoot}.`);

for (const relativePath of files) {
  if (forbiddenPublicSegments.some((segment) => pathSegments(relativePath).includes(segment))) {
    errors.push(`Forbidden local-only path was published: ${relativePath}`);
  }
}

for (const relativePath of htmlFiles) {
  const html = await readFile(path.join(outputRoot, relativePath), "utf8");
  if (!/<body\b/i.test(html)) {
    redirects += 1;
    continue;
  }

  bodyPages.push(relativePath);
  if (!new RegExp(`<body\\b[^>]*\\sdata-basepath=["']${escapeRegExp(basePath)}["']`, "i").test(html)) {
    errors.push(`Generated page is missing data-basepath=${basePath}: ${relativePath}`);
  }
  for (const brand of legacyBrands) {
    if (html.includes(brand)) errors.push(`Generated page contains legacy brand ${brand}: ${relativePath}`);
  }
  for (const segment of forbiddenPublicSegments) {
    const encodedSegment = encodeURIComponent(segment);
    const publicReference = new RegExp(
      `(?:href|src)=["'][^"']*(?:${escapeRegExp(segment)}|${escapeRegExp(encodedSegment)})`,
      "i",
    );
    if (publicReference.test(html)) errors.push(`Generated page links to local-only content ${segment}: ${relativePath}`);
  }

  for (const table of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    if (table[0].includes("[[")) errors.push(`Table contains an unrendered Wiki link: ${relativePath}`);
  }
  for (const asset of [
    "index.css",
    "prescript.js",
    "postscript.js",
    "static/icon.png",
    "static/og-image.png",
  ]) {
    if (html.includes(asset)) errors.push(`Generated page references an unfingerprinted asset ${asset}: ${relativePath}`);
  }
}

const indexHtml = await readRequiredText("index.html");
if (!indexHtml.includes(expectedBrand)) errors.push(`Homepage does not contain brand ${expectedBrand}.`);
if (!indexHtml.includes('<meta property="og:site_name"')) {
  errors.push("Homepage must expose og:site_name as an Open Graph property.");
}
if (publicHost && !indexHtml.includes(`<meta name="twitter:domain" content="${publicHost}"/>`)) {
  errors.push(`Homepage must expose the host-only Twitter domain ${publicHost}.`);
}
if (!indexHtml.includes('<meta property="og:image:type" content="image/png"/>')) {
  errors.push("Homepage must expose the correct social image MIME type.");
}
if (canonicalRoot && !indexHtml.includes(`<link rel="canonical" href="${canonicalRoot}"/>`)) {
  errors.push(`Homepage must expose the canonical public URL ${canonicalRoot}.`);
}

const contentIndex = await readRequiredText("static/contentIndex.json");
const sitemap = await readRequiredText("sitemap.xml");
let contentIndexKeys = [];
try {
  contentIndexKeys = Object.keys(JSON.parse(contentIndex));
} catch {
  errors.push("static/contentIndex.json is not valid JSON.");
}
for (const segment of forbiddenPublicSegments) {
  if (contentIndexKeys.some((key) => pathSegments(key).includes(segment))) {
    errors.push(`contentIndex.json exposes ${segment}.`);
  }
  if (sitemap.includes(segment) || sitemap.includes(encodeURIComponent(segment))) {
    errors.push(`sitemap.xml exposes ${segment}.`);
  }
}

const fingerprints = {};
for (const asset of [
  "index.css",
  "prescript.js",
  "postscript.js",
  "static/icon.png",
  "static/og-image.png",
]) {
  if (files.includes(asset)) errors.push(`Unfingerprinted asset remains in output: ${asset}`);
  const assetDirectory = path.dirname(asset);
  const parsed = path.parse(path.basename(asset));
  const pattern = new RegExp(`^${escapeRegExp(parsed.name)}\\.[0-9a-f]{12}${escapeRegExp(parsed.ext)}$`);
  const matches = files.filter((file) => (
    path.dirname(file) === assetDirectory
    && pattern.test(path.basename(file))
  ));
  if (matches.length !== 1) {
    errors.push(`Expected one fingerprinted ${asset}, found ${matches.length}.`);
  } else {
    [fingerprints[asset]] = matches;
    const content = await readFile(path.join(outputRoot, matches[0]));
    const actualFingerprint = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const expectedBaseName = `${parsed.name}.${actualFingerprint}${parsed.ext}`;
    if (path.basename(matches[0]) !== expectedBaseName) {
      errors.push(`Asset fingerprint does not match content: ${matches[0]} !== ${expectedBaseName}`);
    }
    if (asset.startsWith("static/")) {
      const metadata = await stat(path.join(outputRoot, matches[0]));
      if (metadata.size < 1024) errors.push(`Knowledge brand asset is unexpectedly small: ${matches[0]}`);
    }
  }
}

for (const relativePath of bodyPages) {
  const html = await readFile(path.join(outputRoot, relativePath), "utf8");
  for (const [source, target] of Object.entries(fingerprints)) {
    if (!html.includes(target)) {
      errors.push(`Generated page does not reference fingerprinted ${source} as ${target}: ${relativePath}`);
    }
  }
}

const requiredFolderPage = "07-来源资产索引/index.html";
if (!files.includes(requiredFolderPage)) {
  errors.push(`Missing required folder page: ${requiredFolderPage}`);
} else {
  const folderHtml = await readFile(path.join(outputRoot, requiredFolderPage), "utf8");
  requiredFolderListings = countOccurrences(folderHtml, 'class="page-listing"');
  if (requiredFolderListings !== 1) {
    errors.push(`Required folder page must render exactly one listing, found ${requiredFolderListings}: ${requiredFolderPage}`);
  }
}

if (errors.length) {
  console.error("Knowledge output contract failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  passed: true,
  outputRoot,
  basePath,
  htmlFiles: htmlFiles.length,
  bodyPages: bodyPages.length,
  redirects,
  requiredFolderListings,
  fingerprints,
}, null, 2));

async function readRequiredText(relativePath) {
  if (!files.includes(relativePath)) {
    errors.push(`Missing generated file: ${relativePath}`);
    return "";
  }
  return readFile(path.join(outputRoot, relativePath), "utf8");
}

async function collectFiles(directory, base = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(base, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectFiles(path.join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
  return result.sort();
}

function normalizeBasePath(value) {
  const raw = value.trim();
  if (!raw) return "";
  const pathname = raw.startsWith("/")
    ? raw
    : new URL(raw.includes("://") ? raw : `https://${raw}`).pathname;
  const normalized = `/${pathname.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" ? "" : normalized;
}

function resolvePublicHost(value) {
  const raw = value.trim();
  if (!raw || raw.startsWith("/")) return "";
  return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
}

function resolveCanonicalRoot(value) {
  const raw = value.trim();
  if (!raw || raw.startsWith("/")) return "";
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function pathSegments(value) {
  return value.split("/").map((segment) => decodeURIComponent(segment));
}

function countOccurrences(value, search) {
  return value.split(search).length - 1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
