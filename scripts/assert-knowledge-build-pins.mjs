import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../apps/knowledge/Dockerfile", import.meta.url), "utf8");
const compose = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../deploy/server-deploy.sh", import.meta.url), "utf8");

const quartzRef = readArg("QUARTZ_REF");
const quartzCommit = readArg("QUARTZ_COMMIT");

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

assertContains(compose, `QUARTZ_REF: \${QUARTZ_REF:-${quartzRef}}`, "docker-compose.yml must not override Quartz back to a floating ref.");
assertContains(compose, `QUARTZ_COMMIT: \${QUARTZ_COMMIT:-${quartzCommit}}`, "docker-compose.yml must pass the pinned Quartz commit.");
assertContains(deployScript, `QUARTZ_REF="\${QUARTZ_REF:-${quartzRef}}"`, "server-deploy.sh must default to the pinned Quartz ref.");
assertContains(deployScript, `QUARTZ_COMMIT="\${QUARTZ_COMMIT:-${quartzCommit}}"`, "server-deploy.sh must default to the pinned Quartz commit.");
assertContains(deployScript, "export QUARTZ_COMMIT", "server-deploy.sh must export QUARTZ_COMMIT for compose builds.");

if (errors.length) {
  console.error("Knowledge build pinning is not strict enough:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Knowledge build pins Quartz ${quartzRef} at ${quartzCommit}.`);

function readArg(name) {
  const match = dockerfile.match(new RegExp(`^ARG\\s+${name}=([^\\s#]+)`, "m"));
  return match?.[1];
}

function assertContains(content, expected, message) {
  if (!content.includes(expected)) errors.push(message);
}
