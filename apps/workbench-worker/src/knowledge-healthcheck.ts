import type { PrismaClient } from "@workbench/workbench-db";
import type { WorkerConfig } from "./config.js";

const activeRunStatuses = ["queued", "running", "waiting_input", "cancelling"] as const;

type KnowledgeHealthDatabase = Pick<PrismaClient, "knowledgeRelease">;
type KnowledgeHealthConfig = Pick<WorkerConfig, "knowledgeTool">;

export async function knowledgeToolIsRequired(db: KnowledgeHealthDatabase): Promise<boolean> {
  const release = await db.knowledgeRelease.findFirst({
    where: {
      OR: [
        { status: "ready" },
        { runs: { some: { status: { in: [...activeRunStatuses] } } } },
      ],
    },
    select: { id: true },
  });
  return release !== null;
}

export function assertKnowledgeToolHealth(
  config: KnowledgeHealthConfig,
  required: boolean,
): void {
  if (required && !config.knowledgeTool) {
    throw new Error("KNOWLEDGE_TOOL_REQUIRED_FOR_SERVICEABLE_RELEASE");
  }
}
