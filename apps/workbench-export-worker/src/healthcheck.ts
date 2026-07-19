import { PrismaClient } from "@workbench/workbench-db";

async function main() {
  if (!process.env.WORKBENCH_DATABASE_URL) throw new Error("Missing WORKBENCH_DATABASE_URL");
  const db = new PrismaClient();
  try {
    await db.$queryRaw`SELECT 1`;
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error("[export-worker-healthcheck]", error instanceof Error ? error.message : error);
  process.exit(1);
});
