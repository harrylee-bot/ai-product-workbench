import { PrismaClient } from "@workbench/workbench-db";
import { assertChromiumAvailable } from "./browser/chromium-health.js";
import { loadExportWorkerConfig } from "./config.js";

async function main() {
  const config = loadExportWorkerConfig();
  await assertChromiumAvailable({
    executablePath: config.chromiumExecutablePath,
    timeoutMs: config.browserTimeoutMs,
  });
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
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
