import { PrismaClient } from "@workbench/workbench-db";
import { ClamAvScanAdapter } from "@workbench/workbench-content-security";
import { loadFileWorkerConfig } from "./config.js";

async function main() {
  const config = loadFileWorkerConfig();
  if (process.env.NODE_ENV === "production" && config.scanMode !== "clamav") {
    throw new Error("Production file verification requires WORKBENCH_FILE_SCAN_MODE=clamav");
  }
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await db.$queryRaw`SELECT 1`;
    if (config.scanMode === "clamav") {
      const scanner = new ClamAvScanAdapter(
        requireClamAvHost(config.clamAvHost),
        config.clamAvPort,
        config.clamAvTimeoutMs,
        config.clamAvStreamMaxBytes,
        config.clamAvSignatureMaxAgeMs,
      );
      await scanner.assertReady(config.maximumUploadByteSize);
    }
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error("[file-worker-healthcheck]", error instanceof Error ? error.message : error);
  process.exit(1);
});

function requireClamAvHost(value: string | undefined) {
  if (!value) throw new Error("Missing WORKBENCH_CLAMAV_HOST");
  return value;
}
