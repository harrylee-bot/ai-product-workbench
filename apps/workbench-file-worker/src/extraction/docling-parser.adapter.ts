import { createHash } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import {
  canonicalJson,
  fileExtractionParserComponents,
} from "@workbench/workbench-contracts";
import FormData from "form-data";
import { z } from "zod";
import type { FileWorkerConfig } from "../config.js";
import { RetryableExtractionError, TerminalExtractionError } from "./extraction.errors.js";
import type { ParserPort, ParserResult, ParserSource, ParserTaskStatus } from "./parser.port.js";

const doclingOptions = {
  protocol: "docling-serve.v1.convert-file-async",
  targetType: "inbody",
  toFormats: ["md", "json"],
  imageExportMode: "placeholder",
  doOcr: true,
  forceOcr: false,
} as const;

const failureSchema = z.object({
  category: z.enum([
    "policy",
    "capacity",
    "source_unavailable",
    "target_unavailable",
    "timeout",
    "internal",
    "backend_failure",
    "inference_failure",
    "unknown",
  ]),
  message: z.string().max(4_096),
  retryable: z.boolean(),
  phase: z.enum(["admission", "source_enumeration", "execution", "orchestration"]),
  details: z.record(z.string(), z.string()).optional().default({}),
}).strict();

const taskMetaSchema = z.object({
  num_docs: z.number().int().nonnegative(),
  num_processed: z.number().int().nonnegative(),
  num_succeeded: z.number().int().nonnegative(),
  num_partially_succeeded: z.number().int().nonnegative(),
  num_failed: z.number().int().nonnegative(),
}).strict();

const taskStatusSchema = z.object({
  task_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  task_type: z.literal("convert"),
  task_status: z.enum(["pending", "started", "failure", "success", "partial_success", "skipped"]),
  task_position: z.number().int().nonnegative().nullable().optional(),
  task_meta: taskMetaSchema.nullable().optional(),
  error_message: z.string().max(4_096).nullable().optional(),
  failure: failureSchema.nullable().optional(),
}).strict();

const errorItemSchema = z.object({
  component_type: z.string().min(1).max(120),
  module_name: z.string().min(1).max(240),
  error_message: z.string().max(16_384),
  category: z.string().min(1).max(120),
  page_no: z.number().int().positive().nullable().optional(),
}).strict();

const resultSchema = z.object({
  document: z.object({
    filename: z.string().min(1).max(1_024),
    md_content: z.string().nullable(),
    json_content: z.record(z.string(), z.unknown()).nullable(),
    html_content: z.string().nullable().optional(),
    text_content: z.string().nullable().optional(),
    doctags_content: z.string().nullable().optional(),
    doclang_content: z.string().nullable().optional(),
  }).strict(),
  status: z.enum(["success", "partial_success"]),
  errors: z.array(errorItemSchema).max(10_000),
  processing_time: z.number().finite().nonnegative(),
  timings: z.record(z.string(), z.unknown()),
  confidence: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

const versionSchema = z.object({
  "docling-serve": z.string().min(1).max(120),
  docling: z.string().min(1).max(120),
  "docling-core": z.string().min(1).max(120),
  "docling-parse": z.string().min(1).max(120),
  "docling-jobkit": z.string().min(1).max(120),
  "docling-ibm-models": z.string().min(1).max(120),
  python: z.string().min(1).max(240),
  plaform: z.string().min(1).max(512),
}).strict();

const clearResponseSchema = z.object({ status: z.literal("ok") }).strict();

type Fetch = typeof globalThis.fetch;

export class DoclingParserAdapter implements ParserPort {
  readonly optionsSha256 = createHash("sha256")
    .update(canonicalJson(doclingOptions), "utf8")
    .digest("hex");

  constructor(
    private readonly config: Pick<
      FileWorkerConfig,
      | "doclingUrl"
      | "doclingApiKey"
      | "doclingSubmitTimeoutMs"
      | "doclingPollTimeoutMs"
      | "maximumNormalizedOutputByteSize"
    >,
    private readonly fetchImplementation: Fetch = globalThis.fetch,
  ) {}

  private verifiedComponents: Record<keyof typeof fileExtractionParserComponents, string> | null = null;

  get parserComponents() {
    if (!this.verifiedComponents) throw new Error("DOCLING_CONTRACT_NOT_VERIFIED");
    return this.verifiedComponents;
  }

  async assertContract(signal?: AbortSignal) {
    const response = await this.request("/version", this.config.doclingPollTimeoutMs, signal);
    if (!response.ok) throw responseError("DOCLING_VERSION", response.status);
    const parsed = versionSchema.safeParse(await readJson(response, 1024 ** 2));
    if (!parsed.success) throw new Error("DOCLING_VERSION_RESPONSE_SCHEMA_INVALID");
    for (const component of Object.keys(fileExtractionParserComponents) as Array<keyof typeof fileExtractionParserComponents>) {
      const expected = fileExtractionParserComponents[component];
      if (parsed.data[component] !== expected) {
        throw new Error(`DOCLING_VERSION_MISMATCH:${component}`);
      }
    }
    this.verifiedComponents = Object.freeze({
      "docling-serve": parsed.data["docling-serve"],
      docling: parsed.data.docling,
      "docling-core": parsed.data["docling-core"],
      "docling-parse": parsed.data["docling-parse"],
      "docling-jobkit": parsed.data["docling-jobkit"],
      "docling-ibm-models": parsed.data["docling-ibm-models"],
    });
  }

  async clearResultsOlderThan(retentionSeconds: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 2 * 60 * 60) {
      throw new Error("DOCLING_RESULT_RETENTION_INVALID");
    }
    const response = await this.request(
      `/v1/clear/results?older_then=${retentionSeconds}`,
      this.config.doclingPollTimeoutMs,
      signal,
    );
    if (!response.ok) throw responseError("DOCLING_RESULT_REAPER", response.status);
    const parsed = clearResponseSchema.safeParse(await readJson(response, 1024 ** 2));
    if (!parsed.success) throw new Error("DOCLING_RESULT_REAPER_RESPONSE_INVALID");
  }

  async submit(source: ParserSource, signal?: AbortSignal) {
    const identity = identityCheckingStream(source, signal);
    const form = new FormData();
    form.append("target_type", doclingOptions.targetType);
    for (const format of doclingOptions.toFormats) form.append("to_formats", format);
    form.append("image_export_mode", doclingOptions.imageExportMode);
    form.append("do_ocr", String(doclingOptions.doOcr));
    form.append("force_ocr", String(doclingOptions.forceOcr));
    form.append("files", identity.body, {
      filename: safeFileName(source.fileName),
      contentType: source.mediaType,
      knownLength: source.byteSize,
    });

    let requestBody: PassThrough | null = null;
    let submissionSignal: AbortSignal | null = null;
    let removeAbortListener: () => void = () => undefined;
    try {
      const contentLength = await formLength(form);
      const stream = new PassThrough();
      requestBody = stream;
      stream.once("error", () => undefined);
      form.once("error", (error) => stream.destroy(error));
      form.pipe(stream);
      submissionSignal = requestSignal(signal, this.config.doclingSubmitTimeoutMs);
      const abortSubmission = () => {
        const error = abortError(submissionSignal!);
        identity.cancel(error);
        requestBody?.destroy(error);
        source.body.destroy(error);
      };
      submissionSignal.addEventListener("abort", abortSubmission, { once: true });
      removeAbortListener = () => {
        submissionSignal?.removeEventListener("abort", abortSubmission);
      };
      const response = await this.fetchImplementation(`${this.config.doclingUrl}/v1/convert/file/async`, {
        method: "POST",
        headers: {
          ...form.getHeaders(),
          "content-length": String(contentLength),
          accept: "application/json",
          ...apiKeyHeader(this.config.doclingApiKey),
        },
        body: requestBody as never,
        duplex: "half",
        signal: submissionSignal,
      } as RequestInit & { duplex: "half" });
      if (!response.ok) {
        const error = submissionResponseError(response.status);
        identity.cancel(error);
        requestBody.destroy(error);
        source.body.destroy(error);
        await identity.complete.catch(() => undefined);
        throw error;
      }
      await identity.complete;
      const parsed = parseTaskStatus(await readJson(response, 1024 ** 2));
      if (parsed.task_status === "failure" || parsed.task_status === "skipped") {
        throw terminalTaskError(parsed);
      }
      return parsed.task_id;
    } catch (error) {
      source.body.destroy();
      identity.cancel(error);
      requestBody?.destroy(error instanceof Error ? error : new Error("DOCLING_SUBMISSION_FAILED"));
      await identity.complete.catch(() => undefined);
      if (error instanceof TerminalExtractionError) throw error;
      throw new TerminalExtractionError(
        "failed",
        "DOCLING_SUBMISSION_AMBIGUOUS",
        "Docling submission did not return a durable task id; this extraction will not be resubmitted",
        { cause: error },
      );
    } finally {
      removeAbortListener();
    }
  }

  async poll(taskId: string, signal?: AbortSignal): Promise<ParserTaskStatus> {
    const waitSeconds = Math.max(1, Math.floor((this.config.doclingPollTimeoutMs - 1_000) / 1_000));
    const response = await this.request(
      `/v1/status/poll/${encodeURIComponent(taskId)}?wait=${waitSeconds}`,
      this.config.doclingPollTimeoutMs,
      signal,
    );
    if (response.status === 404 || response.status === 410) throw taskLostError();
    if (!response.ok) throw responseError("DOCLING_STATUS", response.status);
    const parsed = parseTaskStatus(await readJson(response, 1024 ** 2));
    if (parsed.task_id !== taskId) {
      throw new TerminalExtractionError("failed", "DOCLING_TASK_ID_MISMATCH", "Docling returned another task identity");
    }
    if (parsed.task_status === "pending") return { state: "pending" };
    if (parsed.task_status === "started") return { state: "running" };
    if (parsed.task_status === "success") return { state: "succeeded" };
    if (parsed.task_status === "partial_success") return { state: "partially_succeeded" };
    const error = terminalTaskError(parsed);
    return {
      state: "failed",
      terminalStatus: error.terminalStatus,
      code: error.code,
      detail: error.safeDetail,
    };
  }

  async result(taskId: string, signal?: AbortSignal): Promise<ParserResult> {
    const response = await this.request(
      `/v1/result/${encodeURIComponent(taskId)}`,
      this.config.doclingSubmitTimeoutMs,
      signal,
    );
    if (response.status === 404 || response.status === 410) throw taskLostError();
    if (!response.ok) throw responseError("DOCLING_RESULT", response.status);
    const responseLimit = this.config.maximumNormalizedOutputByteSize * 2 + 1024 ** 2;
    const parsed = parseResult(await readJson(response, responseLimit));
    if (parsed.document.md_content === null || parsed.document.json_content === null) {
      throw new TerminalExtractionError(
        "failed",
        "DOCLING_OUTPUT_INCOMPLETE",
        "Docling did not return both Markdown and JSON outputs",
      );
    }
    return {
      markdown: parsed.document.md_content,
      doclingJson: parsed.document.json_content,
      status: parsed.status,
      processingTimeSeconds: parsed.processing_time,
      errorCount: parsed.errors.length,
    };
  }

  private async request(path: string, timeoutMs: number, signal?: AbortSignal) {
    try {
      return await this.fetchImplementation(`${this.config.doclingUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json", ...apiKeyHeader(this.config.doclingApiKey) },
        signal: requestSignal(signal, timeoutMs),
      });
    } catch (cause) {
      throw new RetryableExtractionError(
        "DOCLING_TRANSPORT_UNAVAILABLE",
        "Docling transport is temporarily unavailable",
        { cause },
      );
    }
  }
}

function identityCheckingStream(source: ParserSource, signal?: AbortSignal) {
  const digest = createHash("sha256");
  let byteSize = 0;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const settleResolve = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  const settleReject = (error: unknown) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const complete = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const body = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (signal?.aborted) {
        const error = abortError(signal);
        settleReject(error);
        callback(error);
        return;
      }
      byteSize += chunk.byteLength;
      if (!Number.isSafeInteger(byteSize) || byteSize > source.byteSize) {
        const error = new Error("DOCLING_SOURCE_SIZE_MISMATCH");
        settleReject(error);
        callback(error);
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const sha256 = digest.digest("hex");
      if (byteSize !== source.byteSize || sha256 !== source.sha256) {
        const error = new Error("DOCLING_SOURCE_IDENTITY_MISMATCH");
        settleReject(error);
        callback(error);
        return;
      }
      settleResolve();
      callback();
    },
    destroy(error, callback) {
      settleReject(error ?? new Error("DOCLING_SOURCE_STREAM_CLOSED"));
      callback(error);
    },
  });
  source.body.once("error", settleReject);
  source.body.pipe(body);
  return {
    body,
    complete,
    cancel(error: unknown) {
      const cause = error instanceof Error ? error : new Error("DOCLING_SOURCE_STREAM_CANCELLED");
      settleReject(cause);
      body.destroy(cause);
    },
  };
}

async function readJson(response: Response, maximumBytes: number) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new TerminalExtractionError("failed", "DOCLING_RESPONSE_SIZE_INVALID", "Docling response exceeded its byte limit");
    }
  }
  if (!response.body) throw new TerminalExtractionError("failed", "DOCLING_RESPONSE_BODY_MISSING", "Docling returned no response body");
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    byteSize += chunk.byteLength;
    if (!Number.isSafeInteger(byteSize) || byteSize > maximumBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new TerminalExtractionError("failed", "DOCLING_RESPONSE_SIZE_INVALID", "Docling response exceeded its byte limit");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, byteSize).toString("utf8")) as unknown;
  } catch (cause) {
    throw new TerminalExtractionError("failed", "DOCLING_RESPONSE_INVALID", "Docling returned invalid JSON", { cause });
  }
}

function submissionResponseError(status: number) {
  if ([413, 415, 422].includes(status)) {
    return new TerminalExtractionError("unsupported", "EXTRACTION_UNSUPPORTED", "Docling rejected this file format or size");
  }
  return new TerminalExtractionError("failed", "DOCLING_SUBMISSION_REJECTED", `Docling rejected the submission with HTTP ${status}`);
}

function responseError(prefix: string, status: number) {
  if (status === 401 || status === 403) {
    return new TerminalExtractionError("failed", `${prefix}_AUTH_FAILED`, "Docling authentication failed");
  }
  if (status === 404 || status === 410) return taskLostError();
  if (status === 429 || status >= 500) {
    return new RetryableExtractionError(`${prefix}_UNAVAILABLE`, "Docling is temporarily unavailable");
  }
  return new TerminalExtractionError("failed", `${prefix}_REJECTED`, `Docling returned HTTP ${status}`);
}

function terminalTaskError(status: z.infer<typeof taskStatusSchema>) {
  const policyFailure = status.failure?.category === "policy";
  return new TerminalExtractionError(
    policyFailure ? "unsupported" : "failed",
    policyFailure ? "EXTRACTION_UNSUPPORTED" : "DOCLING_TASK_FAILED",
    policyFailure ? "Docling policy does not support this document" : "Docling could not convert this document",
  );
}

function parseTaskStatus(value: unknown) {
  const parsed = taskStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new TerminalExtractionError("failed", "DOCLING_RESPONSE_SCHEMA_INVALID", "Docling task status violated the pinned response schema");
  }
  return parsed.data;
}

function parseResult(value: unknown) {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    throw new TerminalExtractionError("failed", "DOCLING_RESPONSE_SCHEMA_INVALID", "Docling result violated the pinned response schema");
  }
  return parsed.data;
}

function taskLostError() {
  return new TerminalExtractionError(
    "failed",
    "DOCLING_TASK_LOST",
    "The checkpointed Docling task is unavailable; create a new extraction attempt",
  );
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function apiKeyHeader(apiKey: string): Record<string, string> {
  return { "x-api-key": apiKey };
}

function formLength(form: FormData) {
  return new Promise<number>((resolve, reject) => {
    form.getLength((error, length) => error ? reject(error) : resolve(length));
  });
}

function safeFileName(value: string) {
  const cleaned = value.replace(/[\r\n\0/\\]/g, "_").slice(0, 255);
  return cleaned || "document";
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("FILE_EXTRACTION_ABORTED");
}

export const doclingParserOptions = doclingOptions;
