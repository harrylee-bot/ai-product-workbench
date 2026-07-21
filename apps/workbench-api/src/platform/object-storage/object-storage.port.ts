import type { Readable } from "node:stream";

export const MULTIPART_STORAGE_PORT = Symbol("MULTIPART_STORAGE_PORT");
export const READY_BLOB_STORAGE_PORT = Symbol("READY_BLOB_STORAGE_PORT");
export const CANVAS_VISUAL_STORAGE_PORT = Symbol("CANVAS_VISUAL_STORAGE_PORT");

export type MultipartObjectRef = {
  key: string;
  uploadId: string;
};

export type StoredMultipartPart = {
  partNumber: number;
  etag: string;
  byteSize: number;
};

export type CompleteMultipartPart = Pick<StoredMultipartPart, "partNumber" | "etag">;

export type StoredObjectMetadata = {
  byteSize: number;
  mediaType: string | null;
  etag: string | null;
};

export type StoredObjectBody = {
  body: Readable;
  byteSize: number;
  mediaType: string | null;
  contentRange: string | null;
};

export interface MultipartStoragePort {
  createMultipartUpload(input: {
    key: string;
    mediaType: string;
    metadata: Record<string, string>;
  }): Promise<{ uploadId: string }>;

  signMultipartPart(input: MultipartObjectRef & {
    partNumber: number;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<{
    url: string;
    headers: Record<string, string>;
    expiresAt: Date;
  }>;

  listMultipartParts(input: MultipartObjectRef): Promise<StoredMultipartPart[]>;
  completeMultipartUpload(input: MultipartObjectRef & { parts: CompleteMultipartPart[] }): Promise<void>;
  abortMultipartUpload(input: MultipartObjectRef): Promise<void>;
  statObject(key: string): Promise<StoredObjectMetadata | null>;
}

export interface ReadyBlobStoragePort {
  getObject(input: {
    key: string;
    range?: { start: number; end: number };
    signal?: AbortSignal;
  }): Promise<StoredObjectBody>;
}

/** Dedicated short-lived storage scope for Canvas visual capabilities. */
export interface CanvasVisualStoragePort {
  putObject(input: {
    key: string;
    body: Uint8Array;
    byteSize: number;
    mediaType: string;
    sha256: string;
  }): Promise<void>;
  getObject(input: {
    key: string;
    range?: { start: number; end: number };
    signal?: AbortSignal;
  }): Promise<StoredObjectBody>;
  deleteObject(key: string): Promise<void>;
}
