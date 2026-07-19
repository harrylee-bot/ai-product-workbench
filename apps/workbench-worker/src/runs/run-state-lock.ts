import { Prisma } from "@workbench/workbench-db";

export async function lockRunStatus(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT "status"::TEXT AS "status"
    FROM "runs"
    WHERE "id" = ${runId}
    FOR UPDATE
  `);
  return rows[0]?.status ?? null;
}
