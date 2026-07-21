#!/usr/bin/env node

import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  applyKnowledgeProfileOperatorEvent,
  readKnowledgeProfileOperatorOptions,
} from "./workbench-knowledge-profile-operator-lib.mjs";

const databaseUrl = process.env.WORKBENCH_MIGRATOR_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("Missing WORKBENCH_MIGRATOR_DATABASE_URL");

const options = readKnowledgeProfileOperatorOptions();
const db = new PrismaClient({ datasourceUrl: databaseUrl });

try {
  await db.$connect();
  const result = await applyKnowledgeProfileOperatorEvent({
    db,
    options,
    lockPrincipal: async (tx, principalId) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "principals" WHERE "id" = ${principalId} FOR UPDATE`,
      );
    },
  });
  console.log(JSON.stringify({
    ok: true,
    created: result.created,
    principal: result.principal,
    event: {
      ...result.event,
      id: result.event.id.toString(),
      createdAt: result.event.createdAt.toISOString(),
    },
  }, null, 2));
} finally {
  await db.$disconnect().catch(() => undefined);
}
