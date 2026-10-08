import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const officialGoogleStitchReference = /(?:Google\s+Stitch|@google\/stitch-sdk|StitchToolClient|stitch\.(?:withgoogle|googleapis)\.com|google-labs-code\/stitch|gemini-cli-extensions\/stitch)/iu;
const ignoredDirectories = new Set([
  ".next",
  "coverage",
  "dist",
  "generated",
  "migrations",
  "node_modules",
  "archive",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".example",
  ".yaml",
  ".yml",
  "",
]);
const forbidden = [
  {
    label: "legacy Stitch name",
    pattern: /(?:stitch|stich|sttich|sticht|stitich|sitch)/i,
    allowedFiles: new Set(),
    allowLine: (line, relativePath) =>
      officialGoogleStitchReference.test(line),
  },
  { label: "legacy English product name", pattern: /AI Product Workbench/i },
  {
    label: "legacy ai-product-workbench identifier",
    pattern: /ai[_-]product[_-]workbench/i,
  },
  { label: "legacy product-workbench identifier", pattern: /(?<!ai[_-])product[_-]workbench/i },
];
const requiredBrandSurfaces = [
  {
    relativePath: "apps/web/app/layout.tsx",
    pattern: /applicationName:\s*["']产品工作台["']/u,
    label: "browser application name",
  },
  {
    relativePath: "apps/web/app/layout.tsx",
    pattern: /title:\s*["']产品工作台["']/u,
    label: "browser title",
  },
  {
    relativePath: "apps/web/components/workbench/workbench-home-screen.tsx",
    pattern: />\s*产品工作台\s*</u,
    label: "primary Workbench UI brand",
  },
  {
    relativePath: "packages/workbench-contracts/src/openapi-document.ts",
    pattern: /title:\s*["']产品工作台 API["']/u,
    label: "OpenAPI title",
  },
  {
    relativePath: "README.md",
    pattern: /^## 产品工作台 DeerFlow 部署合同$/mu,
    label: "DeerFlow deployment contract title",
  },
  {
    relativePath: "scripts/generate-workbench-brand-assets.mjs",
    pattern: /const socialDirectory = path\.join\(appDirectory, ["']\(workbench\)["']\);/u,
    label: "current Workbench social image route",
  },
];

const appEntries = await readdir(path.join(repoRoot, "apps"), { withFileTypes: true });
const packageEntries = await readdir(path.join(repoRoot, "packages"), { withFileTypes: true });
const scriptEntries = await readdir(path.join(repoRoot, "scripts"), { withFileTypes: true });
const deployEntries = await readdir(path.join(repoRoot, "deploy"), { withFileTypes: true });
const roots = [
  "README.md",
  "package.json",
  "package-lock.json",
  "docs",
  ".github",
  "apps/knowledge",
  "apps/web",
  ...appEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("workbench-"))
    .map((entry) => path.join("apps", entry.name)),
  ...packageEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("workbench-"))
    .map((entry) => path.join("packages", entry.name)),
  ...scriptEntries
    .filter((entry) => (
      (entry.isDirectory() && entry.name === "e2e")
      || (entry.isFile()
        && /^(?:assert-workbench-|generate-workbench-|workbench-)/u.test(entry.name)
        && entry.name !== "assert-workbench-brand.mjs")
    ))
    .map((entry) => path.join("scripts", entry.name)),
  ...deployEntries
    .filter((entry) => /^workbench(?:[-.])/u.test(entry.name))
    .map((entry) => path.join("deploy", entry.name)),
  "integrations/deerflow",
  "scripts/deerflow-bootstrap.mjs",
  "deploy/server-deploy.sh",
];

const findings = [];
for (const relativeRoot of roots) {
  await inspect(path.join(repoRoot, relativeRoot));
}
for (const required of requiredBrandSurfaces) {
  const content = await readFile(path.join(repoRoot, required.relativePath), "utf8").catch(() => null);
  if (content === null || !required.pattern.test(content)) {
    findings.push(`${required.relativePath}: missing required ${required.label} “产品工作台”`);
  }
}

if (findings.length > 0) {
  console.error("Product brand check failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Product brand check passed: runtime surfaces use 产品工作台/workbench naming.");
}

async function inspect(target) {
  const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    await inspectFile(target);
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) await inspect(child);
    else await inspectFile(child);
  }
}

async function inspectFile(filePath) {
  if (!sourceExtensions.has(path.extname(filePath))) return;
  const relativePath = path.relative(repoRoot, filePath);
  for (const rule of forbidden) {
    if (rule.pattern.test(relativePath) && !rule.allowedFiles?.has(relativePath)) {
      findings.push(`${relativePath}: path contains ${rule.label}`);
    }
  }

  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of forbidden) {
      const lineAllowed = rule.allowedFiles?.has(relativePath) && rule.allowLine?.(lines[index], relativePath);
      if (rule.pattern.test(lines[index]) && !lineAllowed) {
        findings.push(`${relativePath}:${index + 1}: ${rule.label}`);
      }
    }
  }
}
