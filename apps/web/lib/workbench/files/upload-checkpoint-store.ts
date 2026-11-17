"use client";

import type {
  WorkbenchUploadCheckpoint,
  WorkbenchUploadCheckpointStore,
} from "./uppy-multipart";

/**
 * The browser checkpoint deliberately contains no File/blob and no signed URL.
 * The server upload session and its listParts response remain the source of
 * truth for the bytes that have reached object storage.
 */
const WORKBENCH_UPLOAD_CHECKPOINT_DB_NAME = "studio-upload-checkpoints-v1";
const WORKBENCH_UPLOAD_CHECKPOINT_DB_VERSION = 1;
const WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME = "checkpoints";

export type WorkbenchIndexedDbCheckpointStoreOptions = {
  databaseName?: string;
  indexedDB?: IDBFactory;
  onError?: (error: unknown) => void;
};

type StoredCheckpoint = WorkbenchUploadCheckpoint & {
  key: string;
};

let defaultStore: WorkbenchUploadCheckpointStore | null | undefined;

/**
 * Returns the process-wide browser store when IndexedDB is available. The
 * undefined result is intentional for SSR, tests, and browsers where storage
 * is disabled; callers can still upload without pretending that recovery is
 * durable.
 */
export function getDefaultWorkbenchUploadCheckpointStore():
  WorkbenchUploadCheckpointStore | undefined {
  if (defaultStore !== undefined) return defaultStore ?? undefined;
  defaultStore = createWorkbenchUploadCheckpointStore() ?? null;
  return defaultStore ?? undefined;
}

/**
 * Construct an IndexedDB-backed checkpoint store. A factory can be injected by
 * browser tests without bringing a second IndexedDB implementation into the
 * application bundle.
 */
export function createWorkbenchUploadCheckpointStore(
  options: WorkbenchIndexedDbCheckpointStoreOptions = {},
): WorkbenchUploadCheckpointStore | undefined {
  const indexedDBFactory = options.indexedDB ?? resolveIndexedDbFactory();
  if (!indexedDBFactory) return undefined;
  return new IndexedDbWorkbenchUploadCheckpointStore(indexedDBFactory, options);
}

class IndexedDbWorkbenchUploadCheckpointStore implements WorkbenchUploadCheckpointStore {
  private readonly databaseName: string;
  private readonly indexedDB: IDBFactory;
  private readonly onError?: (error: unknown) => void;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(indexedDB: IDBFactory, options: WorkbenchIndexedDbCheckpointStoreOptions) {
    this.indexedDB = indexedDB;
    this.databaseName = options.databaseName ?? WORKBENCH_UPLOAD_CHECKPOINT_DB_NAME;
    this.onError = options.onError;
  }

  async load(projectId: string, fingerprint: string): Promise<WorkbenchUploadCheckpoint | null> {
    return this.withErrorReporting(async () => {
      const database = await this.open();
      const transaction = database.transaction(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME, "readonly");
      const completion = transactionComplete(transaction);
      const request = transaction.objectStore(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME).get(
        checkpointKey(projectId, fingerprint),
      );
      const record = await requestResult<StoredCheckpoint | undefined>(request);
      await completion;
      return record ? stripStorageFields(record) : null;
    });
  }

  async save(checkpoint: WorkbenchUploadCheckpoint): Promise<void> {
    return this.withErrorReporting(async () => {
      const database = await this.open();
      const transaction = database.transaction(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME, "readwrite");
      const record: StoredCheckpoint = {
        ...cloneCheckpoint(checkpoint),
        key: checkpointKey(checkpoint.projectId, checkpoint.fingerprint),
      };
      transaction.objectStore(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME).put(record);
      await transactionComplete(transaction);
    });
  }

  async remove(projectId: string, fingerprint: string): Promise<void> {
    return this.withErrorReporting(async () => {
      const database = await this.open();
      const transaction = database.transaction(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME, "readwrite");
      transaction.objectStore(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME).delete(
        checkpointKey(projectId, fingerprint),
      );
      await transactionComplete(transaction);
    });
  }

  private async open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = openDatabase(this.indexedDB, this.databaseName);
    try {
      const database = await this.databasePromise;
      database.onversionchange = () => database.close();
      return database;
    } catch (error) {
      this.databasePromise = null;
      throw error;
    }
  }

  private async withErrorReporting<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
  }
}

function resolveIndexedDbFactory(): IDBFactory | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const candidate = (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
  return candidate;
}

function openDatabase(indexedDB: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, WORKBENCH_UPLOAD_CHECKPOINT_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME)) {
        database.createObjectStore(WORKBENCH_UPLOAD_CHECKPOINT_STORE_NAME, {
          keyPath: "key",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open Workbench upload checkpoint storage"));
    request.onblocked = () => reject(new Error("Workbench upload checkpoint storage is blocked by another tab"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Workbench upload checkpoint request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Workbench upload checkpoint transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Workbench upload checkpoint transaction aborted"));
  });
}

function checkpointKey(projectId: string, fingerprint: string): string {
  return JSON.stringify([projectId, fingerprint]);
}

function stripStorageFields(record: StoredCheckpoint): WorkbenchUploadCheckpoint {
  const { key: _key, ...checkpoint } = record;
  return cloneCheckpoint(checkpoint);
}

function cloneCheckpoint(checkpoint: WorkbenchUploadCheckpoint): WorkbenchUploadCheckpoint {
  return {
    ...checkpoint,
    session: checkpoint.session ? { ...checkpoint.session } : null,
  };
}
