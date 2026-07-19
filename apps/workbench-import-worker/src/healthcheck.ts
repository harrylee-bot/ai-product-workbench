import { PrismaClient } from "@workbench/workbench-db";
import { ClamAvScanAdapter } from "@workbench/workbench-content-security";
import { loadImportWorkerConfig } from "./config.js";

async function main() {
  const config = loadImportWorkerConfig();
  if (process.env.NODE_ENV === "production" && config.scanMode !== "clamav") {
    throw new Error("Production import verification requires WORKBENCH_FILE_SCAN_MODE=clamav");
  }
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await db.$queryRaw`SELECT 1`;
    if (config.scanMode === "clamav") {
      const scanner = new ClamAvScanAdapter(
        config.clamAvHost,
        config.clamAvPort,
        config.clamAvTimeoutMs,
        config.clamAvStreamMaxBytes,
        config.clamAvSignatureMaxAgeMs,
      );
      await scanner.assertReady(config.maximumImportBlobBytes);
    }
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error("[import-worker-healthcheck]", error instanceof Error ? error.message : error);
  process.exit(1);
});
