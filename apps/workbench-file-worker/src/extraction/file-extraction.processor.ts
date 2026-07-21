import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "@workbench/workbench-contracts";
import type { FileStoragePort, ReadyFileStoragePort } from "../storage/storage.port.js";
import { TerminalExtractionError } from "./extraction.errors.js";
import type { ExtractionOutcome, ExtractionStart, ExtractionStore, NormalizedOutputIdentity } from "./extraction.store.js";
import type { ParserPort } from "./parser.port.js";

export class FileExtractionProcessor {
  constructor(
    private readonly store: ExtractionStore,
    private readonly storage: FileStoragePort & ReadyFileStoragePort,
    private readonly parser: ParserPort,
    private readonly maximumOutputBytes: number,
    private readonly extractionTimeoutMs: number,
  ) {}

  async extract(start: Extract<ExtractionStart, { kind: "run" }>, signal?: AbortSignal): Promise<ExtractionOutcome> {
    const { command, leaseToken } = start;
    let taskId = command.externalTaskId;
    if (start.needsSubmission) {
      if (taskId !== null || command.submissionGeneration !== 1) {
        throw new TerminalExtractionError("failed", "DOCLING_SUBMISSION_STATE_INVALID", "The Docling submission state is invalid");
      }
      const stored = await this.storage.readReadyObject(command.source, signal);
      taskId = await this.parser.submit({
        ...command.source,
        body: stored.body,
      }, signal);
      await this.store.checkpointTask(command.id, leaseToken, taskId);
    }
    if (taskId === null) {
      throw new TerminalExtractionError("failed", "DOCLING_TASK_CHECKPOINT_MISSING", "The extraction has no Docling task checkpoint");
    }

    await this.waitForTask(taskId, command.startedAt, signal);
    const parsed = await this.parser.result(taskId, signal);
    const normalized = normalizeOutputs(parsed.markdown, parsed.doclingJson, this.maximumOutputBytes);
    const reservations = [];
    for (const output of normalized) {
      const reservation = await this.store.reserveOutputBlob(output.identity);
      await this.storage.putContentAddressed({
        body: Readable.from([output.bytes]),
        destinationKey: reservation.canonicalStorageKey,
        byteSize: reservation.byteSize,
        sha256: reservation.sha256,
        mediaType: reservation.storedMediaType,
      }, signal);
      reservations.push(reservation);
    }
    return this.store.publishReady(command.id, leaseToken, reservations, {
      taskId,
      doclingStatus: parsed.status,
      processingTimeSeconds: parsed.processingTimeSeconds,
      errorCount: parsed.errorCount,
    });
  }

  private async waitForTask(taskId: string, startedAt: Date, signal?: AbortSignal) {
    const deadline = startedAt.getTime() + this.extractionTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError(signal);
      const status = await this.parser.poll(taskId, signal);
      if (status.state === "succeeded" || status.state === "partially_succeeded") return;
      if (status.state === "failed") {
        throw new TerminalExtractionError(status.terminalStatus, status.code, status.detail);
      }
      await abortableDelay(250, signal);
    }
    throw new TerminalExtractionError(
      "failed",
      "DOCLING_TASK_TIMEOUT",
      "The checkpointed Docling task exceeded the extraction time limit; create a new extraction attempt",
    );
  }
}

function normalizeOutputs(markdown: string, doclingJson: Record<string, unknown>, maximumBytes: number) {
  const normalizedMarkdown = normalizeMarkdown(markdown);
  let normalizedJson: string;
  try {
    normalizedJson = `${canonicalJson(doclingJson)}\n`;
  } catch (cause) {
    throw new TerminalExtractionError("failed", "DOCLING_JSON_NOT_CANONICALIZABLE", "Docling JSON is not valid JSON data", { cause });
  }
  const outputs = [
    normalizedOutput("markdown", "text/markdown", Buffer.from(normalizedMarkdown, "utf8")),
    normalizedOutput("docling_json", "application/json", Buffer.from(normalizedJson, "utf8")),
  ] as const;
  const totalBytes = outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
  const markdownEmpty = outputs[0].bytes.byteLength === 0;
  if (markdownEmpty || totalBytes > maximumBytes) {
    throw new TerminalExtractionError(
      markdownEmpty ? "unsupported" : "failed",
      markdownEmpty ? "EXTRACTION_EMPTY_CONTENT" : "FILE_EXTRACTION_OUTPUT_SIZE_LIMIT_EXCEEDED",
      markdownEmpty ? "The document contains no extractable content" : "Normalized extraction output exceeded its byte limit",
    );
  }
  return outputs;
}

function normalizedOutput(kind: NormalizedOutputIdentity["kind"], mediaType: string, bytes: Buffer) {
  return {
    bytes,
    identity: {
      kind,
      position: 0 as const,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      mediaType,
    },
  };
}

function normalizeMarkdown(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return "";
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return delay(milliseconds, undefined, { signal, ref: false });
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("FILE_EXTRACTION_ABORTED");
}

export const normalizeExtractionOutputs = normalizeOutputs;
