import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../apps/knowledge/Dockerfile", import.meta.url), "utf8");
const compose = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../deploy/server-deploy.sh", import.meta.url), "utf8");
const quartzConfig = readFileSync(new URL("../apps/knowledge/quartz.config.yaml", import.meta.url), "utf8");
const quartzLock = JSON.parse(readFileSync(new URL("../apps/knowledge/quartz.lock.json", import.meta.url), "utf8"));

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
assertContains(deployScript, "export QUARTZ_REF", "server-deploy.sh must export QUARTZ_REF for compose builds.");
assertContains(deployScript, "export QUARTZ_COMMIT", "server-deploy.sh must export QUARTZ_COMMIT for compose builds.");

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
