import {
  threadEntrySchema,
  type Thread,
  type ThreadEntry,
} from "@workbench/workbench-contracts";

export function mapThread(thread: {
  id: string;
  projectId: string;
  title: string;
  status: Thread["status"];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): Thread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    revision: thread.revision,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function mapThreadEntry(entry: {
  id: string;
  threadId: string;
  sequence: number;
  role: ThreadEntry["role"];
  kind: ThreadEntry["kind"];
  content: unknown;
  producedByRunId: string | null;
  createdAt: Date;
}): ThreadEntry {
  return threadEntrySchema.parse({
    id: entry.id,
    threadId: entry.threadId,
    sequence: entry.sequence,
    role: entry.role,
    kind: entry.kind,
    content: entry.content,
    producedByRunId: entry.producedByRunId,
    createdAt: entry.createdAt.toISOString(),
  });
}
