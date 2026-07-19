export type StoredIdentity = {
  storageKey: string;
  byteSize: number;
  sha256: string;
  mediaType: string;
};

export interface ExportStoragePort {
  readVerified(identity: StoredIdentity, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
  putVerified(identity: StoredIdentity, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
}
