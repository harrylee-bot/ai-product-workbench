import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../apps/knowledge/Dockerfile", import.meta.url), "utf8");

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
