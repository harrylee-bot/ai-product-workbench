import { describe, expect, it, vi } from "vitest";
import { ExportsController } from "../src/modules/exports/exports.controller.js";

function response() {
  return {
    statusCode: 200,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); },
    status(value: number) { this.statusCode = value; return this; },
  };
}

describe("Export GET validators", () => {
  it("returns the changed unreadable projection when an old succeeded ETag is presented", async () => {
    const service = { get: vi.fn()
      .mockResolvedValueOnce({ id: "export-1", revision: 2, status: "succeeded", output: { blobId: "blob-1" } })
      .mockResolvedValueOnce({ id: "export-1", revision: 3, status: "failed", output: null, failure: { code: "EXPORT_OUTPUT_BLOB_NOT_READABLE" } }) };
    const controller = new ExportsController(service as never);
    const first = response();
    const succeeded = await controller.get({ id: "principal-1" } as never, "export-1", undefined, first as never);
    expect(succeeded).toMatchObject({ status: "succeeded" });
    expect(first.headers.get("etag")).toBe('"2"');
    const second = response();
    const failed = await controller.get({ id: "principal-1" } as never, "export-1", '"2"', second as never);
    expect(failed).toMatchObject({ status: "failed", failure: { code: "EXPORT_OUTPUT_BLOB_NOT_READABLE" } });
    expect(second.statusCode).toBe(200);
    expect(second.headers.get("etag")).toBe('"3"');
  });

  it("returns 304 only when the public projection and validator are unchanged", async () => {
    const service = { get: vi.fn().mockResolvedValue({ id: "export-1", revision: 3, status: "failed", output: null, failure: { code: "EXPORT_OUTPUT_BLOB_NOT_READABLE" } }) };
    const controller = new ExportsController(service as never);
    const result = response();
    expect(await controller.get({ id: "principal-1" } as never, "export-1", '"3"', result as never)).toBeUndefined();
    expect(result.statusCode).toBe(304);
    expect(result.headers.get("etag")).toBe('"3"');
  });
});
