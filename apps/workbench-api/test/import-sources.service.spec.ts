import {
  importSourceProcessQueue,
} from "@workbench/workbench-contracts";
import { ImportSourcesService } from "../src/modules/import-sources/import-sources.service.js";

const now = new Date("2026-07-18T12:00:00.000Z");

describe("ImportSourcesService external source transaction", () => {
  it("enlists the Source row, pg-boss job, and queued attempt in one transaction", async () => {
    let createdSource: Record<string, unknown> | undefined;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: {
        findUnique: vi.fn().mockResolvedValue({ role: "editor" }),
      },
      importSource: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          createdSource = {
            id: data.id,
            projectId: data.projectId,
            createdById: data.createdById,
            kind: data.kind,
            status: "pending",
            label: data.label,
            descriptor: null,
            requestHash: data.requestHash,
            checksum: null,
            revision: 0,
            failureCode: null,
            failureDetail: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          return createdSource;
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(() => createdSource),
      },
      importSourceAttempt: {
        create: vi.fn().mockResolvedValue({ id: "import_attempt_1" }),
      },
    };
    const db = {
      importSource: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const access = { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) };
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_import_1") };
    const service = new ImportSourcesService(db as never, access as never, queue as never);

    await expect(service.create(
      "principal_1",
      "project_1",
      "import:url:1",
      { kind: "url_snapshot", sourceUrl: "https://example.com/reference" },
    )).resolves.toMatchObject({
      projectId: "project_1",
      createdById: "principal_1",
      kind: "url_snapshot",
      status: "pending",
      descriptor: null,
      revision: 0,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.importSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project_1",
        createdById: "principal_1",
        kind: "url_snapshot",
        status: "pending",
      }),
      select: expect.any(Object),
    });
    const sourceId = String(createdSource?.id);
    const requestHash = String(createdSource?.requestHash);
    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      importSourceProcessQueue,
      { sourceId, projectId: "project_1", requestHash },
      { singletonKey: sourceId },
    );
    expect(tx.importSourceAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        importSourceId: sourceId,
        projectId: "project_1",
        attempt: 1,
        queueJobId: "job_import_1",
        status: "queued",
      }),
    });
    expect(queue.sendInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(tx.importSourceAttempt.create.mock.invocationCallOrder[0]!);
  });

  it("does not create a queued attempt when transactional queue publication fails", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      importSource: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "source_1" }),
      },
      importSourceAttempt: { create: vi.fn() },
    };
    const db = {
      importSource: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const queueError = new Error("pg-boss rejected job for queue import.source.process");
    const queue = { sendInTransaction: vi.fn().mockRejectedValue(queueError) };
    const service = new ImportSourcesService(
      db as never,
      { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) } as never,
      queue as never,
    );

    await expect(service.create(
      "principal_1",
      "project_1",
      "import:github:1",
      { kind: "github_snapshot", repository: "owner/repository", ref: "main" },
    )).rejects.toBe(queueError);

    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      importSourceProcessQueue,
      expect.objectContaining({ sourceId: "source_1", projectId: "project_1" }),
      { singletonKey: "source_1" },
    );
    expect(tx.importSourceAttempt.create).not.toHaveBeenCalled();
  });
});
