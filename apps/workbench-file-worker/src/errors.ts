import { RetryableScanError } from "@workbench/workbench-content-security";

export class RetryableVerificationError extends RetryableScanError {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, safeDetail, options);
    this.name = "RetryableVerificationError";
  }
}

export function asRetryableVerificationError(error: unknown) {
  if (error instanceof RetryableVerificationError) return error;
  if (error instanceof RetryableScanError) {
    return new RetryableVerificationError(error.code, error.safeDetail, { cause: error });
  }
  return new RetryableVerificationError(
    "FILE_VERIFICATION_INFRASTRUCTURE_ERROR",
    "File verification infrastructure failed",
    { cause: error },
  );
}
