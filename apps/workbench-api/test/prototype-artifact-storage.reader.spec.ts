import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
const { send, clientOptions } = vi.hoisted(() => ({ send: vi.fn(), clientOptions: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { send = send; constructor(options: unknown) { clientOptions(options); } }, GetObjectCommand: class { constructor(readonly input: unknown) {} } }));
import { PrototypeArtifactStorageReader } from "../src/modules/prototypes/prototype-artifact-storage.reader.js";
const config = { get: (key: string) => key.includes("S3_BUCKET") ? "test-bucket" : key.includes("ACCESS_KEY") ? "local-test" : undefined };
const body = Buffer.from("immutable export bytes");
const digest = createHash("sha256").update(body).digest("hex");
const reader = () => new PrototypeArtifactStorageReader(config as never);
const object = () => ({ Body: Readable.from(body), ContentLength: body.length, ContentType: "text/html; charset=utf-8", Metadata: { sha256: digest } });
describe("V2 artifact byte verification", () => {
  it.each([undefined, "false", "true"])("respects configured path style %s for the artifact reader", forcePathStyle => {
    const settings: Record<string, string | undefined> = { WORKBENCH_S3_INTERNAL_ENDPOINT: "https://storage.test", WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: forcePathStyle };
    new PrototypeArtifactStorageReader({ get: (key: string) => key in settings ? settings[key] : config.get(key) } as never);
    expect(clientOptions).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: "https://storage.test", forcePathStyle: forcePathStyle !== "false" }));
  });
  it("rejects an invalid reader path-style setting", () => {
    expect(() => new PrototypeArtifactStorageReader({ get: (key: string) => key === "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE" ? "enabled" : config.get(key) } as never)).toThrow("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE");
  });
  it("returns verified bytes only after checking the actual content digest", async () => {
    send.mockResolvedValueOnce(object());
    const result = await reader().getObject("private/artifact");
    const chunks = []; for await (const chunk of result.body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(body);
    expect(result.sha256).toBe(digest);
  });
  it("rejects corrupt bytes even when object metadata claims the expected hash", async () => {
    send.mockResolvedValueOnce({ ...object(), Body: Readable.from(Buffer.from("x".repeat(body.length))) });
    await expect(reader().getObject("private/artifact")).rejects.toThrow("PROTOTYPE_ARTIFACT_INTEGRITY_FAILURE");
  });
  it("rejects declared size mismatch and missing digest metadata", async () => {
    send.mockResolvedValueOnce({ ...object(), ContentLength: body.length - 1 });
    await expect(reader().getObject("private/artifact")).rejects.toThrow("PROTOTYPE_ARTIFACT_SIZE_MISMATCH");
    send.mockResolvedValueOnce({ ...object(), Metadata: {} });
    await expect(reader().getObject("private/artifact")).rejects.toThrow("PROTOTYPE_ARTIFACT_MANIFEST_INVALID");
  });
});
