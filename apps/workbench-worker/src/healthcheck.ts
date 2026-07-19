import { PrismaClient } from "@workbench/workbench-db";
import { loadWorkerConfig } from "./config.js";
import { assertKnowledgeToolHealth, knowledgeToolIsRequired } from "./knowledge-healthcheck.js";

async function main() {
  const config = loadWorkerConfig();
  const db = new PrismaClient({ datasourceUrl: config.databaseUrl });
  try {
    await db.$queryRaw`SELECT 1`;
    assertKnowledgeToolHealth(config, await knowledgeToolIsRequired(db));
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error("[worker-healthcheck]", error instanceof Error ? error.message : error);
  process.exit(1);
});
