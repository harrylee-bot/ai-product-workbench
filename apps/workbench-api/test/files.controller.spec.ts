import type { Response } from "express";
import { Readable } from "node:stream";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import {
  FilesController,
  parseFileLimit,
  parseFileStatus,
  parsePartNumber,
  requireIdempotencyKey,
} from "../src/modules/files/files.controller.js";
import { UnsatisfiedByteRangeProblem } from "../src/common/byte-content.js";

function responseDouble() {
  const response = { setHeader: vi.fn(), status: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("FilesController", () => {
  it("returns the OpenAPI success status when signing an upload part", () => {
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      FilesController.prototype.signUploadPart,
    )).toBe(200);
  });

  it("strictly parses File filters, multipart part numbers, and required receipts", () => {
    expect(parseFileStatus("ready")).toBe("ready");
    expect(parseFileStatus(undefined)).toBeUndefined();
    expect(parseFileLimit("100")).toBe(100);
    expect(parsePartNumber("10000")).toBe(10_000);
    expect(requireIdempotencyKey("receipt-1")).toBe("receipt-1");
    expect(() => parseFileStatus("deleted")).toThrow();
    expect(() => parseFileStatus("unknown")).toThrow();
    expect(() => parseFileLimit("1.5")).toThrow();
    expect(() => parsePartNumber("1.0")).toThrow();
    expect(() => parsePartNumber("10001")).toThrow();
    expect(() => requireIdempotencyKey(undefined)).toThrow();
  });

  it("sets upload revision and opaque Location when creating a multipart session", async () => {
    const uploads = {
      create: vi.fn().mockResolvedValue({
        file: { id: "file_1" },
        upload: { id: "upload_1", revision: 1 },
      }),
    };
    const controller = new FilesController({} as never, uploads as never);
    const response = responseDouble();
    const body = {
      fileName: "requirements.pdf",
      declaredMediaType: "application/pdf",
      byteSize: 1_024,
    };

    await expect(controller.createUpload(
      { id: "principal_1" } as never,
      "project_1",
      "create-key-1",
      body,
      response as unknown as Response,
    )).resolves.toMatchObject({ upload: { id: "upload_1" } });
    expect(uploads.create).toHaveBeenCalledWith("principal_1", "project_1", "create-key-1", body);
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"1"');
    expect(response.setHeader).toHaveBeenCalledWith("Location", "/api/v1/file-upload-sessions/upload_1");
  });

  it("returns 304 for a weak File revision validator without a response body", async () => {
    const files = { get: vi.fn().mockResolvedValue({ id: "file_1", revision: 7 }) };
    const controller = new FilesController(files as never, {} as never);
    const response = responseDouble();

    await expect(controller.getFile(
      { id: "principal_1" } as never,
      "file_1",
      'W/"7"',
      response as unknown as Response,
    )).resolves.toBeUndefined();
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"7"');
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-cache");
    expect(response.status).toHaveBeenCalledWith(304);
  });

  it("returns a partial StreamableFile with exact digest and range headers", async () => {
    const files = {
      getContent: vi.fn().mockResolvedValue({
        notModified: false,
        etag: `"${"a".repeat(64)}"`,
        body: Readable.from("data"),
        byteSize: 4,
        mediaType: "text/plain",
        fileName: "knowledge notes.txt",
        range: { start: 3, end: 6 },
        contentRange: "bytes 3-6/10",
      }),
    };
    const controller = new FilesController(files as never, {} as never);
    const response = responseDouble();

    const result = await controller.getFileContent(
      { id: "principal_1" } as never,
      "file_1",
      "bytes=3-6",
      undefined,
      response as unknown as Response,
    );
    expect(result).toBeDefined();
    expect(response.status).toHaveBeenCalledWith(206);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Range", "bytes 3-6/10");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Length", "4");
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "inline; filename*=UTF-8''knowledge%20notes.txt",
    );
  });

  it("emits the required unsatisfied Content-Range header on a 416", async () => {
    const files = { getContent: vi.fn().mockRejectedValue(new UnsatisfiedByteRangeProblem(10)) };
    const controller = new FilesController(files as never, {} as never);
    const response = responseDouble();

    await expect(controller.getFileContent(
      { id: "principal_1" } as never,
      "file_1",
      "bytes=20-30",
      undefined,
      response as unknown as Response,
    )).rejects.toMatchObject({ status: 416 });
    expect(response.setHeader).toHaveBeenCalledWith("Content-Range", "bytes */10");
  });

  it("passes strong revision and durable receipt into Extraction creation", async () => {
    const files = {
      createExtraction: vi.fn().mockResolvedValue({
        extraction: { id: "extraction_1" },
        fileRevision: 5,
      }),
    };
    const controller = new FilesController(files as never, {} as never);
    const response = responseDouble();

    await expect(controller.createExtraction(
      { id: "principal_1" } as never,
      "file_1",
      '"4"',
      "extract-key-1",
      response as unknown as Response,
    )).resolves.toEqual({ id: "extraction_1" });
    expect(files.createExtraction).toHaveBeenCalledWith("principal_1", "file_1", 4, "extract-key-1");
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"5"');
    expect(response.setHeader).toHaveBeenCalledWith("Location", "/api/v1/files/file_1");
  });

  it("emits the accepted completion revision and File polling Location", async () => {
    const uploads = {
      complete: vi.fn().mockResolvedValue({
        file: { id: "file_1" },
        upload: { id: "upload_1", revision: 3 },
      }),
    };
    const controller = new FilesController({} as never, uploads as never);
    const response = responseDouble();
    const body = { parts: [{ partNumber: 1, etag: '"etag-1"' }] };

    await controller.completeUpload(
      { id: "principal_1" } as never,
      "upload_1",
      '"1"',
      "complete-key-1",
      body,
      response as unknown as Response,
    );
    expect(uploads.complete).toHaveBeenCalledWith("principal_1", "upload_1", 1, "complete-key-1", body);
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"3"');
    expect(response.setHeader).toHaveBeenCalledWith("Location", "/api/v1/files/file_1");
  });
});
