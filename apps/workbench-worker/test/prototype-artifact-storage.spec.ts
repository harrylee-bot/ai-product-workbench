import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ConditionalObjectCreateMode } from "@workbench/workbench-content-security";
import { describe, expect, it, vi } from "vitest";
import { PrototypeArtifactStorage } from "../src/prototypes/prototype-artifact-storage.js";

const body = new TextEncoder().encode("<html>prototype</html>");
const sha256 = createHash("sha256").update(body).digest("hex");
const identity = { key: "project/revision/export.html", sha256, byteSize: body.byteLength, mediaType: "text/html; charset=utf-8" };

describe("PrototypeArtifactStorage", () => {
  it("uses create-only storage and records the immutable digest", async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    const result = await new PrototypeArtifactStorage({ bucket: "bucket", prefix: "prototype-v2", client: client as never }).putImmutable(identity, body);
    expect(result.key).toBe("prototype-v2/project/revision/export.html");
    const input = client.send.mock.calls[0]![0].input;
    expect(input).toMatchObject({ Bucket: "bucket", Key: result.key, IfNoneMatch: "*", ContentLength: body.byteLength, ContentType: identity.mediaType, Metadata: { sha256 } });
  });

  it("rejects an existing object whose immutable identity differs", async () => {
    const precondition = new S3ServiceException({ name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    const client = { send: vi.fn().mockRejectedValueOnce(precondition).mockResolvedValueOnce({ ContentLength: body.byteLength, ContentType: "application/octet-stream", Metadata: { sha256 } }) };
    await expect(new PrototypeArtifactStorage({ bucket: "bucket", prefix: "prototype-v2", client: client as never }).putImmutable(identity, body)).rejects.toThrow("PROTOTYPE_ARTIFACT_IMMUTABLE_CONFLICT");
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("accepts an equivalent media type normalized by the object store", async () => {
    const precondition = new S3ServiceException({ name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    const client = { send: vi.fn().mockRejectedValueOnce(precondition).mockResolvedValueOnce({ ContentLength: body.byteLength, ContentType: "text/html;charset=utf-8", Metadata: { sha256 }, Body: { transformToByteArray: async () => body } }) };
    const result = await new PrototypeArtifactStorage({ bucket: "bucket", prefix: "prototype-v2", client: client as never }).putImmutable(identity, body);
    expect(result.key).toBe("prototype-v2/project/revision/export.html");
  });

  it("rejects corrupted existing bytes even when the metadata hash matches", async () => {
    const client = { send: vi.fn().mockResolvedValue({ ContentLength: body.byteLength, ContentType: identity.mediaType, Metadata: { sha256 }, Body: { transformToByteArray: async () => new Uint8Array(body.byteLength) } }) };
    await expect(new PrototypeArtifactStorage({ bucket: "bucket", prefix: "prototype-v2", client: client as never }).verifyImmutable(identity)).rejects.toThrow("PROTOTYPE_ARTIFACT_IMMUTABLE_CONFLICT");
  });

  it("rejects bytes whose digest does not match the manifest", async () => {
    await expect(new PrototypeArtifactStorage({ bucket: "bucket", prefix: "prototype-v2", client: { send: vi.fn() } as never }).putImmutable(identity, new TextEncoder().encode("tampered"))).rejects.toThrow("PROTOTYPE_ARTIFACT_IDENTITY_MISMATCH");
  });
});

describe("PrototypeArtifactStorage signed SDK requests", () => {
  function harness(mode: ConditionalObjectCreateMode | undefined) {
    const requests: Array<{ method: string; headers: Record<string, string>; hostname: string; path: string }> = [];
    let stored: Uint8Array | undefined;
    let conflictCode = mode === "oss-forbid-overwrite" ? "FileAlreadyExists" : "PreconditionFailed";
    const client = new S3Client({
      region: "test-region",
      endpoint: "https://storage.test",
      forcePathStyle: false,
      credentials: { accessKeyId: "local-test-key", secretAccessKey: "local-test-secret" },
      maxAttempts: 1,
      requestHandler: {
        handle: async (request) => {
          requests.push({ method: request.method, headers: { ...request.headers }, hostname: request.hostname, path: request.path });
          if (request.method === "PUT") {
            if (stored) {
              const statusCode = conflictCode === "PreconditionFailed" ? 412 : 409;
              return { response: { statusCode, headers: { "content-type": "application/xml" }, body: Readable.from(Buffer.from(`<Error><Code>${conflictCode}</Code><Message>Already exists</Message></Error>`)) } };
            }
            stored = new Uint8Array(body);
            return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
          }
          if (request.method !== "GET" || !stored) throw new Error("Unexpected storage request");
          return { response: { statusCode: 200, headers: { "content-length": String(stored.byteLength), "content-type": identity.mediaType, "x-amz-meta-sha256": sha256 }, body: Readable.from(Buffer.from(stored)) } };
        },
      },
    });
    const storage = new PrototypeArtifactStorage({ bucket: "prototype-tests", prefix: "prototype-v2", client, conditionalCreateMode: mode });
    return { storage, requests, client, corrupt: () => { stored = new Uint8Array(body.byteLength); }, conflict: (code: string) => { conflictCode = code; } };
  }

  it.each([undefined, "oss-forbid-overwrite"] as const)("signs the %s create guard and verifies a replay through the SDK", async mode => {
    const h = harness(mode);
    try {
      const created = await h.storage.putImmutable(identity, body);
      await expect(h.storage.putImmutable(identity, body)).resolves.toEqual(created);
      expect(h.requests.map(request => request.method)).toEqual(["PUT", "PUT", "GET"]);
      for (const request of h.requests.filter(request => request.method === "PUT")) {
        expect(request.hostname).toBe("prototype-tests.storage.test");
        expect(request.path).toBe("/prototype-v2/project/revision/export.html");
        if (mode === "oss-forbid-overwrite") {
          expect(request.headers["x-oss-forbid-overwrite"]).toBe("true");
          expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*x-oss-forbid-overwrite/u);
          expect(request.headers["if-none-match"]).toBeUndefined();
        } else {
          expect(request.headers["if-none-match"]).toBe("*");
          expect(request.headers["x-oss-forbid-overwrite"]).toBeUndefined();
        }
      }
    } finally { h.client.destroy(); }
  });

  it.each(["s3-if-none-match", "oss-forbid-overwrite"] as const)("rejects corrupt stored bytes after a %s conflict", async mode => {
    const h = harness(mode);
    try {
      await h.storage.putImmutable(identity, body);
      h.corrupt();
      await expect(h.storage.putImmutable(identity, body)).rejects.toThrow("PROTOTYPE_ARTIFACT_IMMUTABLE_CONFLICT");
      expect(h.requests.map(request => request.method)).toEqual(["PUT", "PUT", "GET"]);
    } finally { h.client.destroy(); }
  });

  it("does not accept an unrelated OSS 409 as an existing immutable object", async () => {
    const h = harness("oss-forbid-overwrite");
    try {
      await h.storage.putImmutable(identity, body);
      h.conflict("OperationAborted");
      await expect(h.storage.putImmutable(identity, body)).rejects.toMatchObject({ name: "OperationAborted", $metadata: { httpStatusCode: 409 } });
      expect(h.requests.map(request => request.method)).toEqual(["PUT", "PUT"]);
    } finally { h.client.destroy(); }
  });
});
