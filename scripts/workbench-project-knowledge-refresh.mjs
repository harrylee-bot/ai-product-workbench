#!/usr/bin/env node
import { PrismaClient } from "@workbench/workbench-db";
import { planProjectKnowledgeRefresh, refreshProjectKnowledge } from "./workbench-project-knowledge-refresh-lib.mjs";
const flags = {};
for (const argument of process.argv.slice(2)) {
  if (argument === "--execute") { flags.execute = true; continue; }
  const match = /^--(project|principal|baseline|expected-plan-sha256)=(.+)$/u.exec(argument);
  if (!match || Object.hasOwn(flags, match[1])) throw new Error("Invalid or duplicate knowledge refresh argument");
  flags[match[1]] = match[2];
}
if (!flags.project || !flags.principal || !flags.baseline) throw new Error("Required: --project=<id> --principal=<owner-id> --baseline=<ready-global-or-workspace-release-id>");
const datasourceUrl = process.env.WORKBENCH_MIGRATOR_DATABASE_URL?.trim();
if (!datasourceUrl) throw new Error("Missing WORKBENCH_MIGRATOR_DATABASE_URL");
const db = new PrismaClient({ datasourceUrl });
try {
  const input = { projectId: flags.project, principalId: flags.principal, baselineReleaseId: flags.baseline, expectedPlanSha256: flags["expected-plan-sha256"] };
  console.log(JSON.stringify(flags.execute ? await refreshProjectKnowledge(db, input) : await planProjectKnowledgeRefresh(db, input), null, 2));
} finally { await db.$disconnect(); }
