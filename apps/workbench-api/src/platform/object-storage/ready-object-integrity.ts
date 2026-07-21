import { Logger } from "@nestjs/common";
import {
  READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
  readyObjectIntegrityFingerprint,
  recordReadyObjectIntegrityFailure as recordSharedReadyObjectIntegrityFailure,
  type ReadyObjectIntegrityFailure,
  type ReadyObjectIntegrityRecorder,
} from "@workbench/workbench-content-security";
import type { WorkbenchDbService } from "../database/workbench-db.service.js";

const logger = new Logger("ReadyObjectIntegrity");

export {
  READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
  readyObjectIntegrityFingerprint,
};

export function readyObjectIntegrityRecorder(
  db: WorkbenchDbService,
): ReadyObjectIntegrityRecorder {
  return (failure) => recordReadyObjectIntegrityFailure(db, failure);
}

export async function recordReadyObjectIntegrityFailure(
  db: WorkbenchDbService,
  failure: ReadyObjectIntegrityFailure,
): Promise<void> {
  const fingerprint = readyObjectIntegrityFingerprint(failure);
  try {
    const result = await recordSharedReadyObjectIntegrityFailure(db, failure);
    logger.error(
      `incident=${result.incidentId} fingerprint=${result.fingerprint} code=${result.failureCode}`
      + ` blobs_quarantined=${result.blobsQuarantined}`
      + ` files_quarantined=${result.filesQuarantined}`
      + ` visuals_failed=${result.visualsFailed}`,
    );
  } catch {
    logger.error(`persistence_failed fingerprint=${fingerprint} code=${failure.failureCode}`);
    throw new Error("READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED");
  }
}
