#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve(process.argv[2] || process.env.QUARTZ_OUTPUT_DIR || "public");
const configuredBaseUrl = process.argv[3] || process.env.QUARTZ_BASE_URL || "";
const basePath = resolveBasePath(configuredBaseUrl);
const publicHost = resolvePublicHost(configuredBaseUrl);
const assets = await fingerprintAssets(outputRoot, [
  "index.css",
  "prescript.js",
  "postscript.js",
  "static/icon.png",
  "static/og-image.png",
]);
const htmlFiles = await collectHtmlFiles(outputRoot);

if (!htmlFiles.length) {
  throw new Error(`No generated HTML files found under ${outputRoot}`);
}

let updated = 0;
let redirects = 0;
for (const filePath of htmlFiles) {
  const raw = await readFile(filePath, "utf8");
  let next = rewriteAssetReferences(raw, assets);
  next = normalizeSocialMetadata(next, publicHost);
  if (!/<body\b/i.test(raw)) {
    redirects += 1;
  } else {
    next = injectBasePath(next, basePath);
  }
  if (next === raw) continue;
  await writeFile(filePath, next, "utf8");
  updated += 1;
}

console.log(JSON.stringify({ outputRoot, basePath, htmlFiles: htmlFiles.length, updated, redirects, assets }));

async function fingerprintAssets(directory, assetNames) {
  const manifest = [];

  for (const sourceName of assetNames) {
    const sourceDirectory = path.dirname(sourceName);
    const sourceBaseName = path.basename(sourceName);
    const absoluteDirectory = path.join(directory, sourceDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const parsed = path.parse(sourceBaseName);
    const fingerprintPattern = new RegExp(
      `^${escapeRegExp(parsed.name)}\\.[0-9a-f]{12}${escapeRegExp(parsed.ext)}$`,
    );
    const existingFingerprints = fileNames.filter((name) => fingerprintPattern.test(name));
    let currentName = sourceBaseName;

    if (!fileNames.includes(sourceBaseName)) {
      if (existingFingerprints.length !== 1) {
        throw new Error(`Expected ${sourceName} or one fingerprinted variant under ${directory}`);
      }
      [currentName] = existingFingerprints;
    }

    const content = await readFile(path.join(absoluteDirectory, currentName));
    const fingerprint = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const targetBaseName = `${parsed.name}.${fingerprint}${parsed.ext}`;
    if (currentName !== targetBaseName) {
      await rename(
        path.join(absoluteDirectory, currentName),
        path.join(absoluteDirectory, targetBaseName),
      );
    }
    const targetName = sourceDirectory === "."
      ? targetBaseName
      : path.posix.join(sourceDirectory, targetBaseName);
    manifest.push({ source: sourceName, target: targetName });
  }

  return manifest;
}

function rewriteAssetReferences(html, assets) {
  let result = html;
  for (const asset of assets) result = result.replaceAll(asset.source, asset.target);
  return result;
}

function normalizeSocialMetadata(html, publicHost) {
  let result = html
    .replace(/<meta\s+name="og:site_name"/gi, '<meta property="og:site_name"')
    .replace(/(<meta\s+property="og:image:type"\s+content=")image\/\.([a-z0-9.+-]+)("\s*\/?>)/gi, "$1image/$2$3");

  if (publicHost) {
    result = result.replace(
      /<meta\s+property="twitter:domain"\s+content="[^"]*"\s*\/?>/gi,
      `<meta name="twitter:domain" content="${escapeAttribute(publicHost)}"/>`,
    );
  }

  const socialUrl = result.match(/<meta\s+property="og:url"\s+content="([^"]+)"\s*\/?>/i)?.[1];
  if (!socialUrl) return result;
  const canonicalUrl = socialUrl.endsWith("/index") ? socialUrl.slice(0, -"index".length) : socialUrl;
  result = result
    .replace(
      /(<meta\s+property="og:url"\s+content=")[^"]+("\s*\/?>)/gi,
      `$1${escapeAttribute(canonicalUrl)}$2`,
    )
    .replace(
      /(<meta\s+property="twitter:url"\s+content=")[^"]+("\s*\/?>)/gi,
      `$1${escapeAttribute(canonicalUrl)}$2`,
    );

  if (!/<link\s+rel="canonical"/i.test(result)) {
    result = result.replace(
      /<\/head>/i,
      `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}"/></head>`,
    );
  }
  return result;
}

async function collectHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectHtmlFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function resolveBasePath(value) {
  const raw = value.trim();
  if (!raw) return "";

  let pathname;
  if (raw.startsWith("/")) {
    pathname = raw;
  } else {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    pathname = url.pathname;
  }

  const normalized = `/${pathname.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" ? "" : normalized;
}

function resolvePublicHost(value) {
  const raw = value.trim();
  if (!raw || raw.startsWith("/")) return "";
  return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
}

function injectBasePath(html, value) {
  const body = html.match(/<body\b([^>]*)>/i);
  if (!body) throw new Error("Generated HTML is missing a body element");

  const escaped = escapeAttribute(value);
  const attributes = body[1] || "";
  const nextAttributes = /\sdata-basepath=(?:"[^"]*"|'[^']*')/i.test(attributes)
    ? attributes.replace(/\sdata-basepath=(?:"[^"]*"|'[^']*')/i, ` data-basepath="${escaped}"`)
    : `${attributes} data-basepath="${escaped}"`;
  return html.replace(body[0], `<body${nextAttributes}>`);
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
