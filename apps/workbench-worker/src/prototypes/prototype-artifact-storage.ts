import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { conditionalObjectCreateHeader, conditionalObjectCreateInput, isConditionalObjectCreateConflict, setObjectStorageRequestHeader, type ConditionalObjectCreateMode } from "@workbench/workbench-content-security";

export type PrototypeArtifactIdentity = { key: string; sha256: string; byteSize: number; mediaType: string };
export type PrototypeArtifactStorageOptions = { bucket: string; prefix: string; conditionalCreateMode?: ConditionalObjectCreateMode; client?: S3Client };

export class PrototypeArtifactStorage {
  private readonly client: S3Client;
  constructor(private readonly options: PrototypeArtifactStorageOptions) { this.client = options.client ?? new S3Client({}); }

  async putImmutable(identity: PrototypeArtifactIdentity, body: Uint8Array, signal?: AbortSignal): Promise<PrototypeArtifactIdentity> {
    const actualSha256 = sha256(body);
    if (actualSha256 !== identity.sha256 || body.byteLength !== identity.byteSize) throw new Error("PROTOTYPE_ARTIFACT_IDENTITY_MISMATCH");
    const key = `${this.options.prefix.replace(/\/$/u, "")}/${identity.key.replace(/^\//u, "")}`;
    try {
      const mode = this.options.conditionalCreateMode ?? "s3-if-none-match";
      const command = new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: identity.mediaType, ContentLength: body.byteLength, Metadata: { sha256: identity.sha256 }, ...conditionalObjectCreateInput(mode) });
      attachConditionalCreateHeader(command, mode);
      await this.client.send(command, { abortSignal: signal });
      return { ...identity, key };
    } catch (error) {
      if (!isConditionalObjectCreateConflict(error)) throw error;
      await this.verifyImmutable({ ...identity, key }, signal);
      return { ...identity, key };
    }
  }

  async verifyImmutable(identity: PrototypeArtifactIdentity, signal?: AbortSignal): Promise<void> {
    await this.readImmutable(identity, signal);
  }

  async readImmutable(identity: PrototypeArtifactIdentity, signal?: AbortSignal): Promise<Uint8Array> {
    const existing = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: identity.key }), { abortSignal: signal });
    if (!existing.Body || existing.ContentLength !== identity.byteSize || normalizeMediaType(existing.ContentType) !== normalizeMediaType(identity.mediaType) || existing.Metadata?.sha256 !== identity.sha256) throw new Error("PROTOTYPE_ARTIFACT_IMMUTABLE_CONFLICT");
    const body = await existing.Body.transformToByteArray();
    if (body.byteLength !== identity.byteSize || sha256(body) !== identity.sha256) throw new Error("PROTOTYPE_ARTIFACT_IMMUTABLE_CONFLICT");
    return body;
  }
}

function attachConditionalCreateHeader(command: PutObjectCommand, mode: ConditionalObjectCreateMode) {
  const header = conditionalObjectCreateHeader(mode);
  if (!header) return;
  command.middlewareStack.add(
    (next) => async (arguments_) => {
      setObjectStorageRequestHeader(arguments_.request, header);
      return next(arguments_);
    },
    { step: "build", name: "workbenchOssForbidOverwrite", priority: "low" },
  );
}

function sha256(body: Uint8Array): string { return createHash("sha256").update(body).digest("hex"); }
function normalizeMediaType(value: string | undefined): string { return (value ?? "").trim().toLowerCase().replace(/\s*;\s*/gu, ";").replace(/\s*=\s*/gu, "="); }
