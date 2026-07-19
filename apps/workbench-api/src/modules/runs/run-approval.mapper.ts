import {
  approvalOptionsSchema,
  approvalResponseSchema,
  runApprovalSchema,
  type RunApproval,
} from "@workbench/workbench-contracts";

export function mapRunApproval(approval: {
  id: string;
  runId: string;
  kind: string;
  prompt: string;
  options: unknown;
  attempt: number;
  status: RunApproval["status"];
  response: unknown;
  decidedById: string | null;
  decidedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): RunApproval {
  return runApprovalSchema.parse({
    id: approval.id,
    runId: approval.runId,
    kind: approval.kind,
    prompt: approval.prompt,
    options: approvalOptionsSchema.parse(approval.options),
    attempt: approval.attempt,
    status: approval.status,
    response: approvalResponseSchema.parse(approval.response),
    decidedById: approval.decidedById,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    revision: approval.revision,
    createdAt: approval.createdAt.toISOString(),
    updatedAt: approval.updatedAt.toISOString(),
  });
}
