import type { ScanResult } from "@workbench/workbench-content-security";
import type { RetryableVerificationError } from "../errors.js";

export type VerificationCommand = {
  uploadSessionId: string;
  uploadStatus: string;
  stagingKey: string;
  expectedByteSize: bigint;
  expectedSha256: string | null;
  file: {
    id: string;
    status: string;
    byteSize: bigint;
    blobId: string | null;
  };
};

export type ContentIdentity = {
  sha256: string;
  byteSize: number;
  mediaType: string;
};

export type BlobReservation = {
  id: string;
  sha256: string;
  generation: number;
  storageKey: string;
  canonicalStorageKey: string;
  quarantineStorageKey: string;
  mediaType: string;
  byteSize: bigint;
  status: "pending" | "ready" | "quarantined";
  latestScanStatus: "queued" | "running" | "clean" | "infected" | "failed" | null;
};

export type VerificationOutcome = "ready" | "failed" | "quarantined" | "deleted" | "missing";

export type VerificationDelivery = {
  queueJobId: string;
  retryCount: number;
  retryLimit: number;
};

export type AttemptStart =
  | { kind: "run"; attemptId: string }
  | { kind: "terminal"; outcome: VerificationOutcome }
  | { kind: "retryable_replay"; code: string; detail: string };

export type ReconciliationCandidate = {
  uploadSessionId: string;
  attemptCount: number;
};

export type FinalizeVerificationInput = {
  uploadSessionId: string;
  blobId: string;
  promotedStorageKey: string;
  scan: ScanResult | null;
};

export interface VerificationStore {
  beginAttempt(
    uploadSessionId: string,
    delivery: VerificationDelivery,
    maximumAttempts: number,
  ): Promise<AttemptStart>;
  touchAttempt(attemptId: string): Promise<void>;
  completeAttempt(attemptId: string, outcome: VerificationOutcome): Promise<void>;
  recordRetryableFailure(
    attemptId: string,
    error: RetryableVerificationError,
    exhausted: boolean,
  ): Promise<VerificationOutcome | null>;
  exhaustUpload(uploadSessionId: string, lastFailureCode: string): Promise<VerificationOutcome>;
  findReconciliationCandidates(before: Date, limit: number): Promise<ReconciliationCandidate[]>;
  load(uploadSessionId: string): Promise<VerificationCommand | null>;
  reserveBlob(identity: ContentIdentity): Promise<BlobReservation>;
  finalize(input: FinalizeVerificationInput): Promise<VerificationOutcome>;
  failFile(uploadSessionId: string, code: string, detail: string | null): Promise<VerificationOutcome>;
}

export class ContentIdentityConflictError extends Error {
  constructor() {
    super("FILE_CONTENT_IDENTITY_CONFLICT");
  }
}
