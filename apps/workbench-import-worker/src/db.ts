import { PrismaClient } from "@workbench/workbench-db";
import { loadImportWorkerConfig } from "./config.js";

const config = loadImportWorkerConfig();
export const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
