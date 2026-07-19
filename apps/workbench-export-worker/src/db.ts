import { PrismaClient } from "@workbench/workbench-db";
import { loadExportWorkerConfig } from "./config.js";

const config = loadExportWorkerConfig();

export const db = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
});
