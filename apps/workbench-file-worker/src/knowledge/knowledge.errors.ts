export class RetryableKnowledgeBuildError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "RetryableKnowledgeBuildError";
  }
}

export class TerminalKnowledgeBuildError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "TerminalKnowledgeBuildError";
  }
}

export function asKnowledgeBuildError(error: unknown) {
  if (error instanceof RetryableKnowledgeBuildError || error instanceof TerminalKnowledgeBuildError) return error;
  return new RetryableKnowledgeBuildError(
    "KNOWLEDGE_RELEASE_INFRASTRUCTURE_ERROR",
    "Knowledge release infrastructure failed",
    { cause: error },
  );
}
