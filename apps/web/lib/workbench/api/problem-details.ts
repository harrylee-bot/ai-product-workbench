import { problemDetailsSchema, type ProblemDetails } from "@workbench/workbench-contracts";

const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export class WorkbenchApiError extends Error {
  readonly problem: ProblemDetails;
  readonly retryAfterMs: number | null;

  constructor(problem: ProblemDetails, options?: { cause?: unknown; retryAfterMs?: number | null }) {
    super(problem.detail || problem.title, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkbenchApiError";
    this.problem = problem;
    this.retryAfterMs = options?.retryAfterMs ?? null;
  }

  get status(): number {
    return this.problem.status;
  }

  get code(): string {
    return this.problem.code;
  }

  get requestId(): string | undefined {
    return this.problem.requestId;
  }

  get retryable(): boolean {
    return RETRYABLE_STATUSES.has(this.status) || this.status >= 500;
  }
}
export async function problemFromResponse(response: Response): Promise<ProblemDetails> {
  const requestId = response.headers.get("x-request-id") || undefined;
  const text = await response.clone().text();
  const body = parseJson(text);
  const parsed = problemDetailsSchema.safeParse(body);

  if (parsed.success) {
    return parsed.data.requestId || !requestId
      ? parsed.data
      : { ...parsed.data, requestId };
  }

  return {
    type: "about:blank",
    title: response.statusText || `HTTP ${response.status}`,
    status: response.status,
    code: `HTTP_${response.status}`,
    detail: extractFallbackDetail(body, text),
    requestId,
  };
}

export async function workbenchApiErrorFromResponse(response: Response): Promise<WorkbenchApiError> {
  return new WorkbenchApiError(await problemFromResponse(response), {
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
  });
}

export async function throwForWorkbenchResponse(response: Response): Promise<void> {
  if (!response.ok) throw await workbenchApiErrorFromResponse(response);
}

export function isWorkbenchApiError(error: unknown): error is WorkbenchApiError {
  return error instanceof WorkbenchApiError;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractFallbackDetail(body: unknown, text: string): string | undefined {
  if (body && typeof body === "object") {
    const candidate = body as { detail?: unknown; message?: unknown; error?: unknown };
    for (const value of [candidate.detail, candidate.message, candidate.error]) {
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 2_000);
    }
  }

  const plainText = text.trim();
  return plainText ? plainText.slice(0, 2_000) : undefined;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}
