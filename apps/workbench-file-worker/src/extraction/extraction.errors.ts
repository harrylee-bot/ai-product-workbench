import { ReadyObjectIntegrityError } from "@workbench/workbench-content-security";

export type ExtractionTerminalStatus = "failed" | "unsupported";

export class RetryableExtractionError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "RetryableExtractionError";
  }
}

export class TerminalExtractionError extends Error {
  constructor(
    readonly terminalStatus: ExtractionTerminalStatus,
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "TerminalExtractionError";
  }
}

export function asExtractionError(error: unknown) {
  if (error instanceof RetryableExtractionError || error instanceof TerminalExtractionError) return error;
  if (error instanceof ReadyObjectIntegrityError) {
    return new TerminalExtractionError(
      "failed",
      error.failure.failureCode,
      "The immutable extraction source failed byte integrity verification",
      { cause: error },
    );
  }
  return new RetryableExtractionError(
    "FILE_EXTRACTION_INFRASTRUCTURE_ERROR",
    "File extraction infrastructure failed",
    { cause: error },
  );
}
