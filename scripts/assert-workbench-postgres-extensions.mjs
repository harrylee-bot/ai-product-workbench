import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirements = [
  { name: "vector", minimumVersion: "0.7.0", schema: "public" },
  { name: "pg_trgm", minimumVersion: "1.6", schema: "public" },
  { name: "pgcrypto", minimumVersion: "1.3", schema: "public" },
];
const provision = process.argv.includes("--provision");
const check = process.argv.includes("--check");

if (provision === check) {
  throw new Error("Choose exactly one of --provision or --check");
}

const connectionString = provision
  ? required("WORKBENCH_POSTGRES_ADMIN_URL")
  : required("WORKBENCH_DATABASE_URL");
const client = new Client({ connectionString, application_name: "workbench-extension-preflight" });

try {
  await client.connect();
  if (provision) {
    const sql = await readFile(path.join(repoRoot, "deploy/workbench-postgres-extensions.sql"), "utf8");
    await client.query(sql.replace(/^\\set[^\n]*\n/mu, ""));
  }

  const result = await client.query(`
    SELECT extension.extname AS name,
           extension.extversion AS version,
           namespace.nspname AS schema
    FROM pg_extension AS extension
    JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
    WHERE extension.extname = ANY($1::text[])
    ORDER BY extension.extname
  `, [requirements.map(({ name }) => name)]);
  const actual = new Map(result.rows.map((row) => [row.name, row]));
  const findings = [];
  for (const requirement of requirements) {
    const installed = actual.get(requirement.name);
    if (!installed) {
      findings.push(`${requirement.name} is not installed`);
      continue;
    }
    if (installed.schema !== requirement.schema) {
      findings.push(`${requirement.name} must be installed in ${requirement.schema}, found ${installed.schema}`);
    }
    if (compareNumericVersions(installed.version, requirement.minimumVersion) < 0) {
      findings.push(`${requirement.name} ${installed.version} is older than ${requirement.minimumVersion}`);
    }
  }

  console.log(JSON.stringify({
    status: findings.length === 0 ? "ready" : "invalid",
    mode: provision ? "provision" : "check",
    extensions: requirements.map((requirement) => {
      const installed = actual.get(requirement.name);
      return {
        name: requirement.name,
        minimumVersion: requirement.minimumVersion,
        installedVersion: installed?.version ?? null,
        schema: installed?.schema ?? null,
      };
    }),
    findings,
  }, null, 2));
  if (findings.length > 0) process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

function compareNumericVersions(left, right) {
  const leftParts = parseNumericVersion(left);
  const rightParts = parseNumericVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseNumericVersion(value) {
  if (!/^\d+(?:\.\d+)*$/u.test(value)) throw new Error(`Unsupported extension version: ${value}`);
  return value.split(".").map(Number);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
