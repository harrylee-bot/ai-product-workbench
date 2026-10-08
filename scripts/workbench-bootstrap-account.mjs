#!/usr/bin/env node
import { PrismaClient } from "@workbench/workbench-db";
import { ensureWorkbenchPasswordAccount, readBootstrapAccount } from "./workbench-bootstrap-account-lib.mjs";

if (process.argv.slice(2).some((value) => value !== "--execute")) throw new Error("Usage: node scripts/workbench-bootstrap-account.mjs [--execute]");
const input = readBootstrapAccount();
if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({ mode: "plan", action: "ensure-normal-password-account", changesExistingAccounts: false, grantsOperator: false }));
} else {
  const datasourceUrl = process.env.WORKBENCH_MIGRATOR_DATABASE_URL?.trim();
  if (!datasourceUrl) throw new Error("Missing WORKBENCH_MIGRATOR_DATABASE_URL");
  const db = new PrismaClient({ datasourceUrl });
  try {
    const result = await ensureWorkbenchPasswordAccount(db, input);
    console.log(JSON.stringify({ mode: "execute", accountId: result.id, created: result.created, grantsOperator: false }));
  } finally { await db.$disconnect(); }
}
