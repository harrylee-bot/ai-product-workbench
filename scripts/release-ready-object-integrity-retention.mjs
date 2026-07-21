#!/usr/bin/env node

import { Prisma, PrismaClient } from "../packages/workbench-db/generated/client/index.js";

const databaseUrl = process.env.WORKBENCH_MIGRATOR_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("WORKBENCH_MIGRATOR_DATABASE_URL is required");

const fingerprint = argument("incident-fingerprint");
const releaseReference = argument("release-reference");
if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
  throw new Error("READY_OBJECT_INTEGRITY_FINGERPRINT_INVALID");
}
if (!/^[\x20-\x7e]{1,256}$/u.test(releaseReference)) {
  throw new Error("READY_OBJECT_INTEGRITY_RELEASE_REFERENCE_INVALID");
}

const db = new PrismaClient({ datasourceUrl: databaseUrl });
try {
  const release = await db.$transaction(async (tx) => {
    const incidents = await tx.$queryRaw(Prisma.sql`
      SELECT "id", "occurrence_count" AS "occurrenceCount"
      FROM "ready_object_integrity_incidents"
      WHERE "fingerprint" = ${fingerprint}
      FOR UPDATE
    `);
    const incident = incidents[0];
    if (!incident) throw new Error("READY_OBJECT_INTEGRITY_INCIDENT_NOT_FOUND");
    const existing = await tx.readyObjectIntegrityRetentionRelease.findUnique({
      where: {
        incidentId_releasedOccurrenceCount: {
          incidentId: incident.id,
          releasedOccurrenceCount: incident.occurrenceCount,
        },
      },
      select: { releasedAt: true },
    });
    if (existing) {
      return { occurrenceCount: incident.occurrenceCount, releasedAt: existing.releasedAt };
    }
    const created = await tx.readyObjectIntegrityRetentionRelease.create({
      data: {
        incidentId: incident.id,
        releasedOccurrenceCount: incident.occurrenceCount,
        releaseReference,
      },
      select: { releasedAt: true },
    });
    return { occurrenceCount: incident.occurrenceCount, releasedAt: created.releasedAt };
  }, { maxWait: 10_000, timeout: 30_000 });

  console.log(JSON.stringify({
    status: "released",
    incidentFingerprint: fingerprint,
    releasedOccurrenceCount: release.occurrenceCount,
    releasedAt: release.releasedAt.toISOString(),
  }));
} finally {
  await db.$disconnect();
}

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((candidate) => candidate.startsWith(prefix))?.slice(prefix.length).trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
