import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { doclingImageDigest, loadFileWorkerConfig } from "../src/config.js";
import { DoclingParserAdapter } from "../src/extraction/docling-parser.adapter.js";

const config = loadFileWorkerConfig({
  WORKBENCH_DATABASE_URL: "postgresql://user:pass@db:5432/workbench",
  WORKBENCH_S3_BUCKET: "workbench",
  WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID: "file-pipeline-access",
  WORKBENCH_FILE_PIPELINE_S3_SECRET_ACCESS_KEY: "file-pipeline-secret",
  WORKBENCH_DOCLING_URL: "http://docling:5001",
  WORKBENCH_DOCLING_API_KEY: "secret",
  WORKBENCH_DOCLING_RESULTS_REPLAYABLE: "true",
  WORKBENCH_DOCLING_IMAGE_DIGEST: doclingImageDigest,
  WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: "test-embedding-3-r1",
  WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: "a".repeat(64),
  WORKBENCH_KNOWLEDGE_TOKENIZER_JSON_PATH: "/models/embedding-tokenizer/tokenizer.json",
  WORKBENCH_KNOWLEDGE_TOKENIZER_CONFIG_JSON_PATH: "/models/embedding-tokenizer/tokenizer_config.json",
  WORKBENCH_TEI_URL: "http://tei:8080",
  WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
});

const bytes = Buffer.from("source document");
const source = () => ({
  body: Readable.from([bytes]),
  byteSize: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  mediaType: "text/plain",
  fileName: "source.txt",
});

describe("DoclingParserAdapter", () => {
  it("fails startup unless all six Docling component versions match", async () => {
    const exact = new DoclingParserAdapter(config, vi.fn().mockResolvedValue(jsonResponse(versionResponse())) as never);
    await expect(exact.assertContract()).resolves.toBeUndefined();
    expect(exact.parserComponents).toMatchObject({
      "docling-serve": "1.26.0",
      docling: "2.107.0",
      "docling-core": "2.85.0",
      "docling-parse": "7.2.0",
      "docling-jobkit": "2.0.0",
      "docling-ibm-models": "3.13.3",
    });

    const drifted = new DoclingParserAdapter(config, vi.fn().mockResolvedValue(jsonResponse(versionResponse({ docling: "2.108.0" }))) as never);
    await expect(drifted.assertContract()).rejects.toThrow("DOCLING_VERSION_MISMATCH:docling");
    expect(() => drifted.parserComponents).toThrow("DOCLING_CONTRACT_NOT_VERIFIED");
  });

  it("clears only replayable results older than the configured recovery window", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    const adapter = new DoclingParserAdapter(config, fetchImplementation as never);

    await expect(adapter.clearResultsOlderThan(86_400)).resolves.toBeUndefined();

    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://docling:5001/v1/clear/results?older_then=86400",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-api-key": "secret" }),
      }),
    );
    await expect(adapter.clearResultsOlderThan(60)).rejects.toThrow("DOCLING_RESULT_RETENTION_INVALID");
  });

  it("streams one source into the pinned async multipart contract", async () => {
    let requestBody = Buffer.alloc(0);
    let requestHeaders: HeadersInit | undefined;
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = init?.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as never as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      requestBody = Buffer.concat(chunks);
      return jsonResponse({ task_id: "task_1", task_type: "convert", task_status: "pending" });
    });
    const adapter = new DoclingParserAdapter(config, fetchImplementation as never);

    await expect(adapter.submit(source())).resolves.toBe("task_1");

    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://docling:5001/v1/convert/file/async",
      expect.objectContaining({ method: "POST", duplex: "half" }),
    );
    expect(new Headers(requestHeaders).get("x-api-key")).toBe("secret");
    const multipart = requestBody.toString("utf8");
    expect(multipart).toContain('name="target_type"');
    expect(multipart).toContain("inbody");
    expect(multipart.match(/name="to_formats"/g)).toHaveLength(2);
    expect(multipart).toContain("source document");
  });

  it("fails the attempt ambiguously instead of resubmitting when source identity is not proven", async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      for await (const _chunk of init?.body as never as AsyncIterable<Uint8Array>) {
        // Consume the multipart stream so the source identity check runs.
      }
      return jsonResponse({ task_id: "task_1", task_type: "convert", task_status: "pending" });
    });
    const adapter = new DoclingParserAdapter(config, fetchImplementation as never);

    await expect(adapter.submit({ ...source(), sha256: "a".repeat(64) })).rejects.toMatchObject({
      terminalStatus: "failed",
      code: "DOCLING_SUBMISSION_AMBIGUOUS",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("terminates when Docling rejects before consuming the multipart body", async () => {
    const fetchImplementation = vi.fn(async () => new Response("too large", { status: 413 }));
    const adapter = new DoclingParserAdapter(config, fetchImplementation as never);

    await expect(Promise.race([
      adapter.submit(source()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("submit hung")), 500)),
    ])).rejects.toMatchObject({
      terminalStatus: "unsupported",
      code: "EXTRACTION_UNSUPPORTED",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("polls and fetches only the checkpointed task with strict responses", async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: "task_1", task_type: "convert", task_status: "started" }))
      .mockResolvedValueOnce(jsonResponse({
        document: {
          filename: "source.txt",
          md_content: "# Source",
          json_content: { schema_name: "DoclingDocument", version: "1.0.0" },
        },
        status: "success",
        errors: [],
        processing_time: 1.25,
        timings: {},
      }));
    const adapter = new DoclingParserAdapter(config, fetchImplementation as never);

    await expect(adapter.poll("task_1")).resolves.toEqual({ state: "running" });
    await expect(adapter.result("task_1")).resolves.toMatchObject({
      markdown: "# Source",
      status: "success",
      processingTimeSeconds: 1.25,
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toContain("/v1/status/poll/task_1?wait=");
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe("http://docling:5001/v1/result/task_1");
  });

  it("treats a lost checkpointed task and schema drift as terminal", async () => {
    const lost = new DoclingParserAdapter(config, vi.fn().mockResolvedValue(new Response("missing", { status: 404 })) as never);
    await expect(lost.poll("task_1")).rejects.toMatchObject({ code: "DOCLING_TASK_LOST" });

    const drifted = new DoclingParserAdapter(config, vi.fn().mockResolvedValue(jsonResponse({
      task_id: "task_1",
      task_type: "convert",
      task_status: "success",
      unexpected: true,
    })) as never);
    await expect(drifted.poll("task_1")).rejects.toMatchObject({ code: "DOCLING_RESPONSE_SCHEMA_INVALID" });
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function versionResponse(overrides: Record<string, string> = {}) {
  return {
    "docling-serve": "1.26.0",
    docling: "2.107.0",
    "docling-core": "2.85.0",
    "docling-parse": "7.2.0",
    "docling-jobkit": "2.0.0",
    "docling-ibm-models": "3.13.3",
    python: "cpython-312 (3.12.11)",
    plaform: "Linux-test",
    ...overrides,
  };
}
