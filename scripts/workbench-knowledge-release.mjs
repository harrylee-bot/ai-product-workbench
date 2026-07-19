#!/usr/bin/env node

import { fromPrisma, PgBoss } from "pg-boss";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import {
  assertKnowledgeReleaseBuildQueueConfiguration,
  knowledgeReleaseBuildQueue,
  knowledgeReleaseBuildQueueOptions,
} from "@workbench/workbench-contracts";
import {
  createOrQueueKnowledgeRelease,
  readKnowledgeReleaseOptions,
} from "./workbench-knowledge-release-lib.mjs";

const databaseUrl = process.env.WORKBENCH_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("Missing WORKBENCH_DATABASE_URL");

const options = readKnowledgeReleaseOptions();
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const boss = new PgBoss({
  connectionString: pgConnectionString(databaseUrl),
  schema: "workbench_jobs",
  application_name: "workbench-knowledge-release",
  schedule: false,
  supervise: false,
  useListenNotify: false,
});

try {
  await db.$connect();
  await boss.start();
  await boss.createQueue(knowledgeReleaseBuildQueue, knowledgeReleaseBuildQueueOptions);
  assertKnowledgeReleaseBuildQueueConfiguration(await boss.getQueue(knowledgeReleaseBuildQueue));

  const result = await createOrQueueKnowledgeRelease({
    db,
    options,
    lockIdentity: async (tx, identity) => {
      const lockKey = JSON.stringify([identity.key, identity.version]);
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::TEXT AS "lock_receipt"`,
      );
    },
    enqueue: (tx, job, singletonKey) => boss.send(
      knowledgeReleaseBuildQueue,
      job,
      { singletonKey, db: fromPrisma(tx) },
    ),
  });

  console.log(JSON.stringify({
    ok: true,
    release: {
      id: result.release.id,
      key: result.release.key,
      version: result.release.version,
      status: result.release.status,
      embeddingProfileId: result.release.embeddingProfileId,
      embeddingProfileSpecSha256: result.release.embeddingProfileSpecSha256,
      retrievalProfileId: result.release.retrievalProfileId,
      retrievalProfileSpecSha256: result.release.retrievalProfileSpecSha256,
    },
    created: result.created,
    queued: result.queued,
    queueDisposition: result.queueDisposition,
    jobId: result.jobId,
  }, null, 2));
} finally {
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
  await db.$disconnect().catch(() => undefined);
}

function pgConnectionString(value) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url.toString();
}
