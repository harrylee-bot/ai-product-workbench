import type { PrismaClient } from "@workbench/workbench-db";
import type { PrototypeExportExecution, PrototypeExportInput, PrototypeExportResult } from "./temporal-worker.types.js";

type Store = Pick<PrismaClient, "prototypeExport">;

export class PrototypeExportCancelledError extends Error {
  constructor() { super("PROTOTYPE_EXPORT_CANCELLED"); this.name = "PrototypeExportCancelledError"; }
}

async function throwInactiveExecution(db: Store, input: PrototypeExportExecution): Promise<never> {
  const cancelled = await db.prototypeExport.findFirst({
    where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, status: { in: ["cancelling", "cancelled"] } },
    select: { id: true },
  });
  if (cancelled) throw new PrototypeExportCancelledError();
  throw new Error("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
}

export function requirePrototypeExportCommand(input: PrototypeExportExecution): void {
  if (typeof input.commandId !== "string" || !/^prototype_command_[A-Za-z0-9_-]{1,128}$/u.test(input.commandId)) {
    throw new Error("PROTOTYPE_EXPORT_COMMAND_REQUIRED");
  }
}

/** All mutations are fenced by the durable start command, including cleanup. */
export async function startPrototypeExport(db: Store, input: PrototypeExportInput): Promise<PrototypeExportResult | null> {
  requirePrototypeExportCommand(input);
  const row = await db.prototypeExport.findFirst({ where: { id: input.exportId, projectId: input.projectId, revisionId: input.revisionId, format: input.format, activeCommandId: input.commandId } });
  if (!row) throw new Error("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
  if (row.status === "cancelling" || row.status === "cancelled") throw new PrototypeExportCancelledError();
  if (row.status === "succeeded") {
    if (!row.artifactKey || !row.artifactSha256 || !row.byteSize || !row.mediaType) throw new Error("PROTOTYPE_EXPORT_MANIFEST_MISSING");
    return { key: row.artifactKey, sha256: row.artifactSha256, byteSize: row.byteSize, mediaType: row.mediaType };
  }
  const result = await db.prototypeExport.updateMany({
    where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, revision: row.revision, status: { in: ["queued", "building"] } },
    data: { status: "building", revision: { increment: 1 } },
  });
  if (result.count !== 1) await throwInactiveExecution(db, input);
  return null;
}

export async function assertPrototypeExportActive(db: Store, input: PrototypeExportExecution): Promise<void> {
  requirePrototypeExportCommand(input);
  const row = await db.prototypeExport.findFirst({ where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, status: "building" }, select: { id: true } });
  if (!row) await throwInactiveExecution(db, input);
}

export async function finishPrototypeExport(db: Store, input: PrototypeExportExecution, artifact: PrototypeExportResult): Promise<void> {
  requirePrototypeExportCommand(input);
  const result = await db.prototypeExport.updateMany({
    where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, status: "building" },
    data: { status: "succeeded", artifactKey: artifact.key, artifactSha256: artifact.sha256, byteSize: artifact.byteSize, mediaType: artifact.mediaType, failureCode: null, failureDetail: null, finishedAt: new Date(), revision: { increment: 1 } },
  });
  if (result.count === 1) return;
  const replay = await db.prototypeExport.findFirst({ where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, status: "succeeded", artifactKey: artifact.key, artifactSha256: artifact.sha256, byteSize: artifact.byteSize, mediaType: artifact.mediaType }, select: { id: true } });
  if (!replay) await throwInactiveExecution(db, input);
}

export async function failPrototypeExport(db: Store, input: PrototypeExportExecution & { code: string; detail: string }): Promise<void> {
  requirePrototypeExportCommand(input);
  await db.prototypeExport.updateMany({
    where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, status: { in: ["queued", "building"] } },
    data: { status: "failed", failureCode: input.code, failureDetail: input.detail, finishedAt: new Date(), revision: { increment: 1 } },
  });
}

export async function cancelPrototypeExport(db: Store, input: PrototypeExportExecution & { detail: string }): Promise<void> {
  requirePrototypeExportCommand(input);
  await db.prototypeExport.updateMany({
    where: { id: input.exportId, projectId: input.projectId, activeCommandId: input.commandId, status: { in: ["queued", "building", "cancelling"] } },
    data: { status: "cancelled", artifactKey: null, artifactSha256: null, byteSize: null, mediaType: null, failureCode: null, failureDetail: null, finishedAt: new Date(), revision: { increment: 1 } },
  });
}
