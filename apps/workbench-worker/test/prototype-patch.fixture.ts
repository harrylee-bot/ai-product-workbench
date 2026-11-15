import type { RuntimeProgressEvent } from "@workbench/workbench-contracts";
import type { PrismaClient } from "@workbench/workbench-db";
import { PrototypePatchService } from "../src/runs/prototype-patch.service.js";

// Production supplies its existing Run transaction. PostgreSQL tests own the
// transaction here so concurrent receipt tests exercise that same entry point.
export class TransactionalPrototypePatchService extends PrototypePatchService {
  constructor(private readonly db: PrismaClient) { super(); }

  persistPatch(
    runId: string,
    runtimeAttemptId: string,
    event: Extract<RuntimeProgressEvent, { type: "artifact.prototype.patch" }>,
  ) {
    return this.db.$transaction((tx) => this.persistPatchTx(tx, runId, runtimeAttemptId, event));
  }
}
