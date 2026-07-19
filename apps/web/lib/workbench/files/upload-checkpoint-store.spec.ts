import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearWorkbenchUploadCheckpoints,
  createWorkbenchUploadCheckpointStore,
  listWorkbenchUploadCheckpoints,
} from "./upload-checkpoint-store";
import type { WorkbenchUploadCheckpoint } from "./uppy-multipart";

const openedDatabases: string[] = [];

function checkpoint(projectId: string, fingerprint = `workbench-file-v1:${projectId}`): WorkbenchUploadCheckpoint {
  return {
    schemaVersion: 1,
    localUploadId: `local-${projectId}`,
    fingerprint,
    projectId,
    fileName: "brief.pdf",
    declaredMediaType: "application/pdf",
    byteSize: 10,
    lastModified: 1,
    createIdempotencyKey: `create-${projectId}`,
    completionIdempotencyKey: `complete-${projectId}`,
    extractionIdempotencyKey: `extract-${projectId}`,
    submissionIntent: null,
    clientSha256Hint: "a".repeat(64),
    session: {
      fileAssetId: `file-${projectId}`,
      uploadSessionId: `upload-${projectId}`,
      uploadEtag: '"1"',
      partSize: 5 * 1024 * 1024,
      expiresAt: "2026-07-16T00:00:00.000Z",
    },
  };
}

function store() {
  const databaseName = `workbench-upload-checkpoints-test-${crypto.randomUUID()}`;
  openedDatabases.push(databaseName);
  const value = createWorkbenchUploadCheckpointStore({ databaseName, indexedDB });
  if (!value) throw new Error("fake IndexedDB was not available");
  return value;
}

afterEach(async () => {
  await Promise.all(openedDatabases.splice(0).map((databaseName) => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  })));
});

describe("Workbench IndexedDB upload checkpoints", () => {
  it("persists across store instances and keeps Project keys isolated", async () => {
    const first = store();
    const value = checkpoint("project-a", "same-file-metadata");
    await first.save(value);
    await first.save(checkpoint("project-b", "same-file-metadata"));

    const second = createWorkbenchUploadCheckpointStore({
      databaseName: openedDatabases[0],
      indexedDB,
    });
    if (!second) throw new Error("fake IndexedDB was not available");

    await expect(second.load("project-a", "same-file-metadata")).resolves.toEqual(value);
    await expect(second.load("project-b", "same-file-metadata")).resolves.toEqual(
      checkpoint("project-b", "same-file-metadata"),
    );
    await expect(second.load("project-c", "same-file-metadata")).resolves.toBeNull();
    await expect(second.list("project-a")).resolves.toEqual([value]);
  });

  it("does not persist browser File/blob or provider transport details", async () => {
    const checkpointStore = store();
    const value = checkpoint("project-a");
    await checkpointStore.save(value);

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(openedDatabases[0], 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = database
        .transaction("checkpoints", "readonly")
        .objectStore("checkpoints")
        .getAll();
      request.onsuccess = () => resolve(request.result[0] as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });

    expect(record).not.toHaveProperty("file");
    expect(record).not.toHaveProperty("blob");
    expect(record).not.toHaveProperty("signedUrl");
    expect(record).not.toHaveProperty("providerUploadId");
  });

  it("clears only one Project's pending checkpoints", async () => {
    const checkpointStore = store();
    await checkpointStore.save(checkpoint("project-a", "a"));
    await checkpointStore.save(checkpoint("project-a", "b"));
    await checkpointStore.save(checkpoint("project-b", "c"));

    await clearWorkbenchUploadCheckpoints("project-a", checkpointStore);

    await expect(listWorkbenchUploadCheckpoints("project-a", checkpointStore)).resolves.toEqual([]);
    await expect(listWorkbenchUploadCheckpoints("project-b", checkpointStore)).resolves.toEqual([
      checkpoint("project-b", "c"),
    ]);
  });
});
