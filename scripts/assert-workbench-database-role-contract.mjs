#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFileArgument = process.argv.find((value) => value.startsWith("--env-file="))?.slice("--env-file=".length);
const values = envFileArgument ? parseEnvFile(envFileArgument) : process.env;

const adminUrl = required("WORKBENCH_POSTGRES_ADMIN_URL");
const migratorUrl = required("WORKBENCH_MIGRATOR_DATABASE_URL");
const runtimeUrl = required("WORKBENCH_DATABASE_URL");
const adminRole = required("WORKBENCH_POSTGRES_USER");
const migratorRole = required("WORKBENCH_POSTGRES_MIGRATOR_USER");
const runtimeRole = required("WORKBENCH_POSTGRES_RUNTIME_USER");
const migratorPassword = required("WORKBENCH_POSTGRES_MIGRATOR_PASSWORD");
const runtimePassword = required("WORKBENCH_POSTGRES_RUNTIME_PASSWORD");

for (const [name, value] of [
  ["WORKBENCH_POSTGRES_ADMIN_URL", adminUrl],
  ["WORKBENCH_MIGRATOR_DATABASE_URL", migratorUrl],
  ["WORKBENCH_DATABASE_URL", runtimeUrl],
  ["WORKBENCH_POSTGRES_USER", adminRole],
  ["WORKBENCH_POSTGRES_MIGRATOR_USER", migratorRole],
  ["WORKBENCH_POSTGRES_RUNTIME_USER", runtimeRole],
]) {
  if (value.includes("REPLACE_WITH_")) throw new Error(`${name} still contains a placeholder`);
}

assertRoleName(adminRole, "WORKBENCH_POSTGRES_USER");
assertRoleName(migratorRole, "WORKBENCH_POSTGRES_MIGRATOR_USER");
assertRoleName(runtimeRole, "WORKBENCH_POSTGRES_RUNTIME_USER");
if (new Set([adminRole, migratorRole, runtimeRole]).size !== 3) {
  throw new Error("WORKBENCH_DATABASE_ROLES_MUST_BE_DISTINCT");
}
if (migratorPassword === runtimePassword) throw new Error("WORKBENCH_DATABASE_ROLE_PASSWORDS_MUST_BE_DISTINCT");

assertDatabaseUrl(adminUrl, adminRole, false, "WORKBENCH_POSTGRES_ADMIN_URL");
assertDatabaseUrl(migratorUrl, migratorRole, true, "WORKBENCH_MIGRATOR_DATABASE_URL");
assertDatabaseUrl(runtimeUrl, runtimeRole, true, "WORKBENCH_DATABASE_URL");

console.log(JSON.stringify({
  status: "ready",
  adminRole,
  migratorRole,
  runtimeRole,
  databaseHost: new URL(runtimeUrl).hostname,
}));

function parseEnvFile(path) {
  const result = {};
  for (const line of readFileSync(resolve(path), "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function required(name) {
  const value = values[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertRoleName(value, name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`${name} must be a lower-case PostgreSQL role identifier`);
}

function assertDatabaseUrl(value, expectedUser, requireSchema, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error(`${name} must use PostgreSQL`);
  if (parsed.hostname !== "postgres") throw new Error(`${name} must use the Compose postgres hostname`);
  if (parsed.username !== expectedUser) throw new Error(`${name} username must match its dedicated role`);
  if (parsed.pathname !== "/workbench") throw new Error(`${name} must target the workbench database`);
  if (requireSchema && parsed.searchParams.get("schema") !== "workbench") {
    throw new Error(`${name} must select the workbench schema`);
  }
}
