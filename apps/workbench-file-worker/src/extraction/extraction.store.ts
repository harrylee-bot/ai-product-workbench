import type { RetryableExtractionError, TerminalExtractionError } from "./extraction.errors.js";

export type ExtractionOutcome = "ready" | "unsupported" | "failed" | "missing" | "busy";

export type ExtractionDelivery = {
  queueJobId: string;
  retryCount: number;
  retryLimit: number;
};

export type ExtractionCommand = {
  id: string;
  fileAssetId: string;
  status: "running";
  parser: string;
  parserVersion: string;
  outputSchemaVersion: number;
  processingAttempts: number;
  submissionGeneration: number;
  startedAt: Date;
  externalTaskId: string | null;
  source: {
    storageKey: string;
    sha256: string;
    byteSize: number;
    mediaType: string;
    fileName: string;
  };
};

export type ExtractionStart =
  | { kind: "run"; leaseToken: string; needsSubmission: boolean; command: ExtractionCommand }
  | { kind: "terminal"; outcome: Exclude<ExtractionOutcome, "busy"> }
  | { kind: "busy" };

export type NormalizedOutputIdentity = {
  kind: "markdown" | "docling_json";
  position: 0;
  sha256: string;
  byteSize: number;
  mediaType: string;
};

export type OutputBlobReservation = NormalizedOutputIdentity & {
  blobId: string;
  generation: number;
  storageKey: string;
  canonicalStorageKey: string;
  storedMediaType: string;
  status: "pending" | "ready";
};

export type ExtractionTerminalMetadata = {
  taskId: string;
  doclingStatus: "success" | "partial_success";
  processingTimeSeconds: number;
  errorCount: number;
};

export type ExtractionReconciliationCandidate = {
  extractionId: string;
  processingAttempts: number;
};

export interface ExtractionStore {
  beginDelivery(
    extractionId: string,
    delivery: ExtractionDelivery,
    maximumAttempts: number,
    leaseMs: number,
  ): Promise<ExtractionStart>;
  checkpointTask(extractionId: string, leaseToken: string, taskId: string): Promise<void>;
  reserveOutputBlob(identity: NormalizedOutputIdentity): Promise<OutputBlobReservation>;
  publishReady(
    extractionId: string,
    leaseToken: string,
    outputs: OutputBlobReservation[],
    metadata: ExtractionTerminalMetadata,
  ): Promise<ExtractionOutcome>;
  fail(
    extractionId: string,
    leaseToken: string | null,
    error: TerminalExtractionError,
  ): Promise<ExtractionOutcome>;
  recordRetryableFailure(
    extractionId: string,
    leaseToken: string,
    error: RetryableExtractionError,
    exhausted: boolean,
  ): Promise<ExtractionOutcome | null>;
  exhaust(extractionId: string, code: string): Promise<ExtractionOutcome>;
  findReconciliationCandidates(before: Date, limit: number): Promise<ExtractionReconciliationCandidate[]>;
}
