import { createHash } from "node:crypto";
import {
  canonicalJson,
  designSystemDocumentSchema,
  prototypeDocumentSchema,
  publicArtifactVersionDetailSchema,
  publicDesignSystemDocumentSchema,
  publicPrototypeDocumentSchema,
  shareGrantSchema,
  type ProjectReleaseArtifactPin,
  type PublicArtifactVersionDetail,
  type ShareGrant,
} from "@workbench/workbench-contracts";
import { sanitizePublicJson } from "../releases/release.mapper.js";

export type ShareGrantRecord = {
  id: string;
  releaseId: string;
  artifactVersionId?: string | null;
  createdById: string;
  scope: "view" | "remix";
  status: "active" | "revoked" | "expired";
  revision: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function mapShareGrant(record: ShareGrantRecord): ShareGrant {
  return shareGrantSchema.parse({
    id: record.id,
    releaseId: record.releaseId,
    ...(record.artifactVersionId ? { artifactVersionId: record.artifactVersionId } : {}),
    createdById: record.createdById,
    scope: record.scope,
    status: record.status,
    revision: record.revision,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export type SharedArtifactVersionRecord = {
  id: string;
  artifactId: string;
  projectId: string;
  version: number;
  schemaVersion: number;
  status: string;
  content: unknown;
  checksum: string;
  citations: unknown;
  createdAt: Date;
  contentBlob: {
    mediaType: string;
    byteSize: bigint;
    sha256: string;
    status: string;
    deletedAt: Date | null;
  } | null;
};

export function mapPublicArtifactVersion(
  record: SharedArtifactVersionRecord,
  pin: ProjectReleaseArtifactPin,
): PublicArtifactVersionDetail {
  if (
    record.id !== pin.artifactVersionId
    || record.artifactId !== pin.artifactId
    || record.version !== pin.version
    || record.schemaVersion !== pin.schemaVersion
    || record.status !== "ready"
    || record.checksum !== pin.checksum
  ) {
    throw new Error("PUBLIC_SHARE_ARTIFACT_PIN_MISMATCH");
  }

  const common = {
    artifactId: record.artifactId,
    artifactVersionId: record.id,
    version: record.version,
    kind: pin.kind,
    schemaVersion: record.schemaVersion,
    status: "ready" as const,
    checksum: record.checksum,
    citations: [],
    createdAt: record.createdAt.toISOString(),
  };
  let detail: PublicArtifactVersionDetail;
  if (record.contentBlob === null) {
    if (record.content === null) throw new Error("PUBLIC_SHARE_ARTIFACT_CONTENT_MISSING");
    const content = pin.kind === "prototype"
      ? publicPrototypeDocumentSchema.parse(sanitizePublicJson(prototypeDocumentSchema.parse(record.content)))
      : pin.kind === "design_system"
        ? publicDesignSystemDocumentSchema.parse(sanitizePublicJson(designSystemDocumentSchema.parse(record.content)))
        : sanitizePublicJson(record.content);
    detail = publicArtifactVersionDetailSchema.parse({
      ...common,
      contentMode: "inline",
      content,
    });
  } else {
    if (
      record.content !== null
      || record.contentBlob.status !== "ready"
      || record.contentBlob.deletedAt !== null
    ) {
      throw new Error("PUBLIC_SHARE_ARTIFACT_BLOB_NOT_READY");
    }
    detail = publicArtifactVersionDetailSchema.parse({
      ...common,
      contentMode: "blob",
      blob: {
        mediaType: record.contentBlob.mediaType,
        byteSize: safeByteSize(record.contentBlob.byteSize),
        sha256: record.contentBlob.sha256,
        fileName: null,
      },
    });
  }
  return detail;
}

export function publicArtifactVersionEtag(detail: PublicArtifactVersionDetail) {
  return `"${createHash("sha256").update(canonicalJson(detail)).digest("hex")}"`;
}

function safeByteSize(value: bigint) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("PUBLIC_SHARE_ARTIFACT_BYTE_SIZE_INVALID");
  }
  return parsed;
}
