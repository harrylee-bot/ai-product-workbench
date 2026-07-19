import type { Readable } from "node:stream";

export type StoredObject = {
  body: Readable;
  byteSize: number;
  mediaType: string | null;
};

export type PromotedObject = {
  sourceKey: string;
  destinationKey: string;
  byteSize: number;
  sha256: string;
  mediaType: string;
};

export type ContentAddressedObject = {
  body: Readable;
  destinationKey: string;
  byteSize: number;
  sha256: string;
  mediaType: string;
};

export interface FileStoragePort {
  getObject(key: string, signal?: AbortSignal): Promise<StoredObject>;
  promoteObject(object: PromotedObject, signal?: AbortSignal): Promise<void>;
  putContentAddressed(object: ContentAddressedObject, signal?: AbortSignal): Promise<void>;
  deleteObject(key: string, signal?: AbortSignal): Promise<void>;
}
