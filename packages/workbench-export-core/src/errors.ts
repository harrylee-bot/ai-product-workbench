export class TerminalExportError extends Error {
  constructor(
    readonly code: string,
    readonly safeDetail: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${safeDetail}`, options);
    this.name = "TerminalExportError";
  }
}

export function boundedDetail(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/[\r\n\t]+/g, " ").slice(0, 4_000);
}
