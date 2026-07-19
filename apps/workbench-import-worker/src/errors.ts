export class RetryableImportError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "RetryableImportError";
  }
}

export class TerminalImportError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "TerminalImportError";
  }
}

export function safeFailure(error: unknown) {
  if (error instanceof RetryableImportError || error instanceof TerminalImportError) {
    return { code: error.code, detail: error.safeDetail };
  }
  return { code: "IMPORT_WORKER_FAILURE", detail: "Import worker failed while freezing the source" };
}
