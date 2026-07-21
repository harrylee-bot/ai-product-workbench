import type { VerifiedReadyObjectBody } from "@workbench/workbench-content-security";

export type ParserSource = {
  body: VerifiedReadyObjectBody;
  byteSize: number;
  sha256: string;
  mediaType: string;
  fileName: string;
};

export type ParserTaskStatus =
  | { state: "pending" | "running" }
  | { state: "succeeded" | "partially_succeeded" }
  | { state: "failed"; terminalStatus: "failed" | "unsupported"; code: string; detail: string };

export type ParserResult = {
  markdown: string;
  doclingJson: Record<string, unknown>;
  status: "success" | "partial_success";
  processingTimeSeconds: number;
  errorCount: number;
};

export interface ParserPort {
  readonly optionsSha256: string;
  submit(source: ParserSource, signal?: AbortSignal): Promise<string>;
  poll(taskId: string, signal?: AbortSignal): Promise<ParserTaskStatus>;
  result(taskId: string, signal?: AbortSignal): Promise<ParserResult>;
}
