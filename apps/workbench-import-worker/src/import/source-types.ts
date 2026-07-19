import { createHash } from "node:crypto";
import { canonicalJson, runSourceBlobLimit, type CreateImportSourceRequest, type ImportSourceDescriptor } from "@workbench/workbench-contracts";

export const maximumImportSourceManifestBlobs = runSourceBlobLimit;

export type FrozenImportBlob = {
  path: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
};

export type FrozenImport = {
  label: string;
  descriptor: ImportSourceDescriptor;
  checksum: string;
  blobs: FrozenImportBlob[];
};

export function freezeImport(input: {
  label: string;
  descriptor: ImportSourceDescriptor;
  blobs: Array<{ path: string; mediaType: string; bytes: Buffer }>;
}): FrozenImport {
  const blobs = input.blobs.map((blob) => ({
    ...blob,
    sha256: createHash("sha256").update(blob.bytes).digest("hex"),
  }));
  const checksum = createHash("sha256").update(canonicalJson({
    protocol: "workbench.import-source.v1",
    descriptor: input.descriptor,
    blobs: blobs.map(({ path, mediaType, bytes, sha256 }) => ({ path, mediaType, byteSize: bytes.byteLength, sha256 })),
  })).digest("hex");
  return { label: input.label, descriptor: input.descriptor, checksum, blobs };
}

export interface ImportProvider {
  supports(kind: CreateImportSourceRequest["kind"]): boolean;
  freeze(request: Exclude<CreateImportSourceRequest, { kind: "file" | "design_md" }>, signal?: AbortSignal): Promise<FrozenImport>;
}
