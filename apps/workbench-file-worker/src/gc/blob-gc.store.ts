export type BlobGcCandidate = {
  readonly blobId: string;
};

export type BlobGcClaim =
  | { readonly kind: "delete"; readonly storageKey: string; readonly attemptCount: number }
  | { readonly kind: "complete" | "exhausted" | "missing" | "not_due" | "referenced" };

export type BlobGcEligibilityResult = {
  readonly cleared: number;
  readonly marked: number;
};

export type BlobGcDeletionResult = "complete" | "deleted" | "missing" | "referenced";

export interface BlobGcStore {
  reconcileEligibility(
    now: Date,
    eligibleAt: Date,
    limit: number,
  ): Promise<BlobGcEligibilityResult>;
  findCandidates(now: Date, maximumAttempts: number, limit: number): Promise<BlobGcCandidate[]>;
  claim(blobId: string, now: Date, maximumAttempts: number): Promise<BlobGcClaim>;
  deleteClaimed(
    blobId: string,
    storageKey: string,
    completedAt: Date,
    deleteObject: () => Promise<void>,
  ): Promise<BlobGcDeletionResult>;
  recordFailure(blobId: string, code: string, detail: string, occurredAt: Date): Promise<void>;
  complete(blobId: string, completedAt: Date): Promise<void>;
}
