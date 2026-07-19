import { PrismaClient } from "@workbench/workbench-db";
import type { PreviewConfig } from "./config.js";

export function createPreviewDb(config: Pick<PreviewConfig, "databaseUrl">) {
  return new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
}
