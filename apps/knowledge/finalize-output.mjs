#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputRoot = path.resolve(process.argv[2] || process.env.QUARTZ_OUTPUT_DIR || "public");
const basePath = resolveBasePath(process.argv[3] || process.env.QUARTZ_BASE_URL || "");
const htmlFiles = await collectHtmlFiles(outputRoot);

if (!htmlFiles.length) {
  throw new Error(`No generated HTML files found under ${outputRoot}`);
}

let updated = 0;
let redirects = 0;
for (const filePath of htmlFiles) {
  const raw = await readFile(filePath, "utf8");
  if (!/<body\b/i.test(raw)) {
    redirects += 1;
    continue;
  }
  const next = injectBasePath(raw, basePath);
  if (next === raw) continue;
  await writeFile(filePath, next, "utf8");
  updated += 1;
}

console.log(JSON.stringify({ outputRoot, basePath, htmlFiles: htmlFiles.length, updated, redirects }));

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
