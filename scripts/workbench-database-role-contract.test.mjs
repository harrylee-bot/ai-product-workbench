import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/assert-workbench-database-role-contract.mjs");

test("knowledge maintenance commands require the dedicated migrator URL", () => {
  const operator = readFileSync(resolve("scripts/workbench-knowledge-profile-operator.mjs"), "utf8");
  const release = readFileSync(resolve("scripts/workbench-knowledge-release.mjs"), "utf8");
  const readme = readFileSync(resolve("README.md"), "utf8");
  assert.match(operator, /process\.env\.WORKBENCH_MIGRATOR_DATABASE_URL/iu);
  assert.doesNotMatch(operator, /WORKBENCH_DATABASE_URL\?\.trim/iu);
  assert.match(release, /process\.env\.WORKBENCH_MIGRATOR_DATABASE_URL/iu);
  assert.doesNotMatch(release, /WORKBENCH_MIGRATOR_DATABASE_URL\s*\?\?/u);
  assert.equal(
    [...readme.matchAll(/^WORKBENCH_MIGRATOR_DATABASE_URL=/gmu)].length,
    2,
    "README must show the dedicated URL for both knowledge maintenance commands",
  );
  assert.equal(
    [...readme.matchAll(/^WORKBENCH_DATABASE_URL="postgresql:\/\//gmu)].length,
    0,
    "README must not show the runtime URL as a knowledge maintenance command credential",
  );
});

test("accepts distinct admin, migrator, and runtime database URLs", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"runtimeRole":"workbench_runtime"/u);
});

test("rejects a runtime URL that uses the migrator role", () => {
  const result = run({
    WORKBENCH_DATABASE_URL: "postgresql://workbench_migrator:runtime@postgres:5432/workbench?schema=workbench",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /username must match its dedicated role|ROLES_MUST_BE_DISTINCT/u);
});

test("rejects a missing schema or placeholder password", () => {
  const result = run({
    WORKBENCH_MIGRATOR_DATABASE_URL: "postgresql://workbench_migrator:REPLACE_WITH_PASSWORD@postgres:5432/workbench",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /placeholder|select the workbench schema/u);
});

test("reserves forensic release authority for the migrator role", () => {
  const provisioner = readFileSync(resolve("scripts/provision-workbench-database-roles.mjs"), "utf8");
  assert.match(
    provisioner,
    /GRANT CREATE ON DATABASE[^\n]+TO \$\{migratorRole\}/u,
    "the migrator needs database CREATE so Prisma's initial CREATE SCHEMA migration can run",
  );
  assert.match(
    provisioner,
    /REVOKE CREATE ON DATABASE[^\n]+FROM \$\{runtimeRole\}/u,
    "the runtime role must not inherit database-level CREATE",
  );
  assert.match(
    provisioner,
    /GRANT SELECT, INSERT, UPDATE ON TABLE[^\n]+ready_object_integrity_incidents/u,
  );
  assert.match(
    provisioner,
    /REVOKE DELETE, TRUNCATE ON TABLE[^\n]+ready_object_integrity_incidents/u,
  );
  assert.match(
    provisioner,
    /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE[^\n]+ready_object_integrity_retention_releases/u,
  );
  assert.match(
    provisioner,
    /GRANT SELECT ON TABLE[^\n]+ready_object_integrity_retention_releases/u,
  );
});

function run(overrides) {
  const directory = mkdtempSync(join(tmpdir(), "workbench-db-role-contract-"));
  const envPath = join(directory, "workbench.env");
  const values = {
    WORKBENCH_POSTGRES_ADMIN_URL: "postgresql://workbench_admin:admin@postgres:5432/workbench",
    WORKBENCH_MIGRATOR_DATABASE_URL: "postgresql://workbench_migrator:migrator@postgres:5432/workbench?schema=workbench",
    WORKBENCH_DATABASE_URL: "postgresql://workbench_runtime:runtime@postgres:5432/workbench?schema=workbench",
    WORKBENCH_POSTGRES_USER: "workbench_admin",
    WORKBENCH_POSTGRES_MIGRATOR_USER: "workbench_migrator",
    WORKBENCH_POSTGRES_RUNTIME_USER: "workbench_runtime",
    WORKBENCH_POSTGRES_MIGRATOR_PASSWORD: "migrator",
    WORKBENCH_POSTGRES_RUNTIME_PASSWORD: "runtime",
    ...overrides,
  };
  writeFileSync(envPath, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  try {
    return spawnSync(process.execPath, [script, `--env-file=${envPath}`], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
