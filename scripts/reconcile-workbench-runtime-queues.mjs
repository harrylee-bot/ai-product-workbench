#!/usr/bin/env node

import { reconcileRuntimeQueues } from "@workbench/workbench-contracts";
import { PgBoss } from "pg-boss";

const configuredDatabaseUrl = (process.env.WORKBENCH_MIGRATOR_DATABASE_URL ?? process.env.WORKBENCH_DATABASE_URL)?.trim();
if (!configuredDatabaseUrl) throw new Error("WORKBENCH_MIGRATOR_DATABASE_URL is required");

const databaseUrl = new URL(configuredDatabaseUrl);
databaseUrl.searchParams.delete("schema");
const boss = new PgBoss({
  application_name: "workbench-runtime-queue-reconciler",
  connectionString: databaseUrl.toString(),
  schedule: false,
  schema: "workbench_jobs",
  supervise: false,
  migrate: true,
  createSchema: true,
  useListenNotify: false,
});
boss.on("error", (error) => console.error("[runtime-queue-reconciler]", error));

let started = false;
try {
  await boss.start();
  started = true;
  await reconcileRuntimeQueues(boss, {
    allowPolicyRecreate: process.env.WORKBENCH_ALLOW_RUNTIME_QUEUE_RECREATE === "1",
  });
  console.log("Runtime queues match the deployed contract.");
} finally {
  if (started) await boss.stop({ graceful: true, timeout: 30_000 });
}
