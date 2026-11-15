import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const images = {
  "workbench-api": ["apps/workbench-api/Dockerfile", "WORKBENCH_API_IMAGE_REF", "workbench-api"],
  "workbench-web": ["apps/web/Dockerfile", "WORKBENCH_WEB_IMAGE_REF", "workbench-web"],
  "workbench-worker": ["apps/workbench-worker/Dockerfile", "WORKBENCH_RUNTIME_WORKER_IMAGE_REF", "workbench-runtime-worker"],
  "workbench-temporal-worker": ["apps/workbench-worker/Dockerfile.temporal", "WORKBENCH_TEMPORAL_WORKER_IMAGE_REF", "workbench-temporal-worker"],
  "workbench-file-worker": ["apps/workbench-file-worker/Dockerfile", "WORKBENCH_FILE_WORKER_IMAGE_REF", "workbench-file-worker"],
  "workbench-import-worker": ["apps/workbench-import-worker/Dockerfile", "WORKBENCH_IMPORT_WORKER_IMAGE_REF", "workbench-import-worker"],
  "workbench-export-worker": ["apps/workbench-export-worker/Dockerfile", "WORKBENCH_EXPORT_WORKER_IMAGE_REF", "workbench-export-worker"],
  "workbench-preview": ["apps/workbench-preview/Dockerfile", "WORKBENCH_PREVIEW_IMAGE_REF", "workbench-preview"],
  knowledge: ["apps/knowledge/Dockerfile", "WORKBENCH_KNOWLEDGE_IMAGE_REF", "workbench-knowledge"],
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const matches = (file, input) => file === input || file.startsWith(`${input}/`);
const ignored = new Set([".git", "node_modules", "dist", ".next", "output", "coverage", "__pycache__"]);

// Run on the freshly extracted archive BEFORE generating any build output.
function sourceSnapshot(root, directory = "", result = {}) {
  for (const entry of readdirSync(join(root, directory)).sort()) {
    if (ignored.has(entry) || entry.endsWith(".tsbuildinfo")) continue;
    const relative = directory ? `${directory}/${entry}` : entry;
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) result[relative] = digest(`link:${readlinkSync(absolute)}`);
    else if (stat.isDirectory()) sourceSnapshot(root, relative, result);
    else result[relative] = digest(Buffer.concat([Buffer.from(`${stat.mode & 0o111}:`), readFileSync(absolute)]));
  }
  return result;
}

export function copyInputs(dockerfile) {
  if (/--mount=type=bind/.test(dockerfile)) throw new Error("Bind mount inputs require an explicit release dependency rule");
  const inputs = [];
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (!/^\s*(COPY|ADD)\s/i.test(line)) continue;
    if (/\s--from=/.test(line)) continue;
    const words = line.trim().split(/\s+/).slice(1).filter(word => !word.startsWith("--"));
    for (const word of words.slice(0, -1)) {
      // Unsupported syntax must never silently omit an image input.
      if (!/^[a-zA-Z0-9_.\/-]+$/.test(word) || word.split("/").includes("..")) {
        throw new Error(`Unsupported Docker input: ${word}`);
      }
      inputs.push(word.replace(/^\.\//, "").replace(/\/$/, ""));
    }
  }
  return inputs;
}

export function planRelease({ snapshot, previous, inputs, force = false }) {
  const changed = Object.keys({ ...previous?.snapshot, ...snapshot })
    .filter(file => snapshot[file] !== previous?.snapshot?.[file]);
  const selected = new Set();
  let full = force || previous?.version !== 1;
  for (const file of changed) {
    if (["package.json", "package-lock.json", "tsconfig.base.json", ".dockerignore"].includes(file)) full = true;
    if (file.startsWith("packages/workbench-db/") || file.startsWith("packages/workbench-contracts/")) full = true;
    let matched = false;
    for (const [service, sources] of Object.entries(inputs)) {
      if (sources.some(input => matches(file, input))) { selected.add(service); matched = true; }
    }
    // Documentation is skippable only when it is not an image input.
    if (!matched && /^(docs\/|README\.md$|AGENTS\.md$)/.test(file)) continue;
    // Deployment/queue policy, unknown files and future entry points fail to full release.
    if (!matched || file.startsWith("deploy/") || file.startsWith("scripts/")) full = true;
  }
  const services = full ? Object.keys(images) : [...selected].sort();
  return { version: 1, mode: full ? "all" : services.length ? "selected" : "none", services, changed, snapshot };
}

export function releaseEnv(base, plan, sourceRoot, commit, tag) {
  const values = {
    WORKBENCH_APP_DIR: sourceRoot,
    WORKBENCH_SOURCE_COMMIT: commit,
  };
  const lines = base.split(/\r?\n/);
  const old = Object.fromEntries(lines.filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  values.WORKBENCH_RUNTIME_WORKER_SOURCE_COMMIT = plan.services.includes("workbench-worker")
    ? commit : old.WORKBENCH_RUNTIME_WORKER_SOURCE_COMMIT || old.WORKBENCH_SOURCE_COMMIT;
  for (const service of plan.services) {
    const [, key, name] = images[service];
    values[key] = `${name}:${tag}`;
  }
  if (plan.mode === "all") values.WORKBENCH_API_MIGRATOR_IMAGE_REF = `workbench-api-migrator:${tag}`;
  const seen = new Set();
  const result = lines.map(line => {
    const key = line.slice(0, line.indexOf("="));
    if (!(key in values)) return line;
    if (seen.has(key)) throw new Error(`Duplicate release environment key: ${key}`);
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) result.push(`${key}=${value}`);
  return result.join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, previousPath, baseEnvPath, output, commit, tag] = process.argv.slice(2);
  const base = readFileSync(baseEnvPath, "utf8");
  let previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, "utf8")) : null;
  // Manual environment changes, a failed cutover or an interrupted promotion require a full release.
  if (previous?.envDigest !== digest(base)) previous = null;
  const inputs = Object.fromEntries(Object.entries(images).map(([service, [file]]) => [service, [file, ...copyInputs(readFileSync(join(root, file), "utf8"))]]));
  const plan = planRelease({ snapshot: sourceSnapshot(root), previous, inputs, force: process.env.WORKBENCH_FORCE_FULL_RELEASE === "1" });
  writeFileSync(`${output}/release-plan.json`, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(`${output}/direct.env`, releaseEnv(base, plan, root, commit, tag), { mode: 0o600 });
  console.log(`Release plan: ${plan.mode}; services: ${plan.services.join(", ") || "none"}; changed files: ${plan.changed.length}`);
}
