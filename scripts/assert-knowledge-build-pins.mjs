import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../apps/knowledge/Dockerfile", import.meta.url), "utf8");
const knowledgeEntrypoint = readFileSync(new URL("../apps/knowledge/docker-entrypoint.sh", import.meta.url), "utf8");
const knowledgeNginx = readFileSync(new URL("../apps/knowledge/nginx.conf", import.meta.url), "utf8");
const compose = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../deploy/server-deploy.sh", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const quartzConfig = readFileSync(new URL("../apps/knowledge/quartz.config.yaml", import.meta.url), "utf8");
const quartzLock = JSON.parse(readFileSync(new URL("../apps/knowledge/quartz.lock.json", import.meta.url), "utf8"));
const quartzPatches = [
  {
    path: "apps/knowledge/patches/0001-quartz-v5-prevent-duplicate-virtual-page-content.patch",
    containerPath: "/opt/quartz-patches/0001-quartz-v5-prevent-duplicate-virtual-page-content.patch",
    sha256: "4d88c201229f6481a9457362199fde04c96c9330b869a7ab731337ff8ffdaebf",
  },
  {
    path: "apps/knowledge/patches/0002-quartz-v5-disable-dangerous-raw-html.patch",
    containerPath: "/opt/quartz-patches/0002-quartz-v5-disable-dangerous-raw-html.patch",
    sha256: "640cab14de249e65b1d2f5dbca785964977bfbd00cdf8153847093c1d7031c78",
  },
].map((patch) => ({
  ...patch,
  content: readFileSync(new URL(`../${patch.path}`, import.meta.url), "utf8"),
}));

const quartzRef = readArg("QUARTZ_REF");
const quartzCommit = readArg("QUARTZ_COMMIT");
const configPluginSources = [...quartzConfig.matchAll(/^\s*-\s*source:\s*(github:[^\s#]+)/gm)].map(
  (match) => match[1],
);
const configPluginNames = configPluginSources.map(extractPluginName);
const lockedPlugins = quartzLock.plugins ?? {};
const lockedPluginNames = Object.keys(lockedPlugins);

const errors = [];

if (!quartzRef || quartzRef === "v5" || quartzRef === "main" || quartzRef === "master") {
  errors.push(`QUARTZ_REF must be a pinned tag, got ${quartzRef ?? "missing"}.`);
}

if (!/^[0-9a-f]{40}$/i.test(quartzCommit ?? "")) {
  errors.push(`QUARTZ_COMMIT must be a full 40-character commit SHA, got ${quartzCommit ?? "missing"}.`);
}

if (!dockerfile.includes('test "$(git rev-parse HEAD)" = "${QUARTZ_COMMIT}"')) {
  errors.push("Knowledge Dockerfile must verify the checked-out Quartz commit.");
}

if (!dockerfile.includes(".quartz-source-revision")) {
  errors.push("Knowledge Dockerfile must persist the Quartz source revision for runtime inspection.");
}

assertContains(
  dockerfile,
  "COPY apps/knowledge/quartz.lock.json /opt/quartz/quartz.lock.json",
  "Knowledge Dockerfile must copy the Quartz plugin lockfile.",
);
assertContains(
  dockerfile,
  "npx quartz plugin install",
  "Knowledge Dockerfile must install Quartz plugins from the lockfile.",
);
assertContains(
  dockerfile,
  "COPY apps/knowledge/static/icon.png /opt/quartz/quartz/static/icon.png",
  "Knowledge Dockerfile must replace the default Quartz icon.",
);
assertContains(
  dockerfile,
  "COPY apps/knowledge/static/og-image.png /opt/quartz/quartz/static/og-image.png",
  "Knowledge Dockerfile must replace the default Quartz social image.",
);
assertContains(
  dockerfile,
  "COPY scripts/assert-knowledge-output.mjs /usr/local/lib/knowledge-assert-output.mjs",
  "Knowledge Dockerfile must include the generated-output contract check.",
);
const dependencyInstallIndex = dockerfile.indexOf("npm ci --no-audit --no-fund");
for (const patch of quartzPatches) {
  assertContains(
    dockerfile,
    `COPY ${patch.path} ${patch.containerPath}`,
    `Knowledge Dockerfile must copy pinned Quartz patch ${patch.path}.`,
  );
  assertContains(
    dockerfile,
    `git apply --check ${patch.containerPath}`,
    `Knowledge Dockerfile must check Quartz patch ${patch.path} before applying it.`,
  );
  assertContains(
    dockerfile,
    `git apply ${patch.containerPath}`,
    `Knowledge Dockerfile must apply Quartz patch ${patch.path}.`,
  );

  const checkIndex = dockerfile.indexOf(`git apply --check ${patch.containerPath}`);
  const applyIndex = dockerfile.indexOf(`git apply ${patch.containerPath}`);
  if (
    checkIndex === -1
    || applyIndex === -1
    || dependencyInstallIndex === -1
    || checkIndex > applyIndex
    || applyIndex > dependencyInstallIndex
  ) {
    errors.push(`Knowledge Dockerfile must check and apply ${patch.path} before installing dependencies.`);
  }

  const actualSha256 = createHash("sha256").update(patch.content).digest("hex");
  if (actualSha256 !== patch.sha256) {
    errors.push(`Quartz patch checksum mismatch for ${patch.path}: ${actualSha256} !== ${patch.sha256}.`);
  }
}

const installBlock = dockerfile.slice(
  dockerfile.indexOf("npx quartz plugin install"),
  dockerfile.indexOf("npx quartz plugin install") + 1000,
);
for (const name of lockedPluginNames) {
  if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(installBlock)) {
    errors.push("Knowledge Dockerfile must not pass plugin names to `npx quartz plugin install`; use quartz.lock.json instead.");
    break;
  }
}

if (configPluginNames.length === 0) {
  errors.push("Knowledge Quartz config must list the external plugins it needs.");
}

if (lockedPluginNames.length !== configPluginNames.length) {
  errors.push(
    `Knowledge plugin lockfile must cover exactly the configured plugins (${configPluginNames.length}), got ${lockedPluginNames.length}.`,
  );
}

for (const [index, source] of configPluginSources.entries()) {
  const name = configPluginNames[index];
  const locked = lockedPlugins[name];
  if (!locked) {
    errors.push(`Knowledge plugin lockfile is missing ${name}.`);
    continue;
  }
  if (locked.source !== source) {
    errors.push(`Knowledge plugin ${name} lock source mismatch: ${locked.source} !== ${source}.`);
  }
  if (!/^https:\/\/github\.com\/quartz-community\/[^/]+\.git$/.test(locked.resolved ?? "")) {
    errors.push(`Knowledge plugin ${name} must resolve to a quartz-community GitHub repository.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(locked.commit ?? "")) {
    errors.push(`Knowledge plugin ${name} must be locked to a full 40-character commit SHA.`);
  }
  if ("installedAt" in locked) {
    errors.push(`Knowledge plugin ${name} lock entry must not include timestamp noise.`);
  }
}

for (const name of lockedPluginNames) {
  if (!configPluginNames.includes(name)) {
    errors.push(`Knowledge plugin lockfile has an unused plugin entry: ${name}.`);
  }
}

assertContains(compose, `QUARTZ_REF: \${QUARTZ_REF:-${quartzRef}}`, "docker-compose.yml must not override Quartz back to a floating ref.");
assertContains(compose, `QUARTZ_COMMIT: \${QUARTZ_COMMIT:-${quartzCommit}}`, "docker-compose.yml must pass the pinned Quartz commit.");
assertContains(deployScript, `QUARTZ_REF="\${QUARTZ_REF:-${quartzRef}}"`, "server-deploy.sh must default to the pinned Quartz ref.");
assertContains(deployScript, `QUARTZ_COMMIT="\${QUARTZ_COMMIT:-${quartzCommit}}"`, "server-deploy.sh must default to the pinned Quartz commit.");
assertContains(
  deployScript,
  'KNOWLEDGE_APP_PUBLIC_URL="${APP_PUBLIC_URL%/}/knowledge"',
  "HTTPS deployments must default the knowledge URL to the public /knowledge route.",
);
assertContains(deployScript, "export QUARTZ_REF", "server-deploy.sh must export QUARTZ_REF for compose builds.");
assertContains(deployScript, "export QUARTZ_COMMIT", "server-deploy.sh must export QUARTZ_COMMIT for compose builds.");
assertContains(envExample, `QUARTZ_REF="${quartzRef}"`, ".env.example must use the pinned Quartz ref.");
assertContains(envExample, `QUARTZ_COMMIT="${quartzCommit}"`, ".env.example must include the pinned Quartz commit.");
assertContains(quartzConfig, "  pageTitle: 策划宝产品知识库", "Knowledge Quartz config must use the public product brand.");
assertContains(quartzConfig, "    - _templates", "Knowledge Quartz config must exclude templates from public output.");
assertContains(quartzConfig, "    - 99-收件箱", "Knowledge Quartz config must exclude the local inbox from public output.");
assertContains(quartzConfig, "      layout: legacy", "Knowledge table of contents must use the accessible native-details layout.");
assertContains(
  compose,
  '"127.0.0.1:${KNOWLEDGE_APP_PORT:-3001}:3000"',
  "Knowledge container port must only bind to loopback.",
);
const finalizeIndex = knowledgeEntrypoint.indexOf("knowledge-finalize-output.mjs");
const outputAssertIndex = knowledgeEntrypoint.indexOf("knowledge-assert-output.mjs");
const healthMarkerIndex = knowledgeEntrypoint.indexOf("printf 'ok\\n'");
if (
  finalizeIndex === -1
  || outputAssertIndex === -1
  || healthMarkerIndex === -1
  || finalizeIndex > outputAssertIndex
  || outputAssertIndex > healthMarkerIndex
) {
  errors.push("Knowledge entrypoint must finalize and validate output before publishing its health marker.");
}
assertContains(
  knowledgeNginx,
  "Content-Security-Policy",
  "Knowledge Nginx must publish a Content-Security-Policy.",
);
assertContains(
  knowledgeNginx,
  "script-src-attr 'none'",
  "Knowledge CSP must block inline event-handler attributes.",
);
assertContains(
  knowledgeNginx,
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "Knowledge CSP must retain the Quartz Graph runtime compatibility allowance.",
);
assertContains(
  knowledgeNginx,
  'Cache-Control "public, max-age=31536000, immutable"',
  "Knowledge Nginx must cache fingerprinted assets as immutable.",
);

if (errors.length) {
  console.error("Knowledge build pinning is not strict enough:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Knowledge build pins Quartz ${quartzRef} at ${quartzCommit} with ${lockedPluginNames.length} locked plugins.`);

function readArg(name) {
  const match = dockerfile.match(new RegExp(`^ARG\\s+${name}=([^\\s#]+)`, "m"));
  return match?.[1];
}

function assertContains(content, expected, message) {
  if (!content.includes(expected)) errors.push(message);
}

function extractPluginName(source) {
  return source.replace("github:", "").split("#")[0].split("/").at(-1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
