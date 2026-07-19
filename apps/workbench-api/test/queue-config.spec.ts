import {
  importSourceProcessQueue,
  importSourceProcessQueueOptions,
} from "@workbench/workbench-contracts";
import {
  createAndAssertImportSourceQueue,
  pgConnectionString,
} from "../src/platform/queue/workbench-queue.service.js";

describe("pg-boss database configuration", () => {
  it("removes the Prisma-only schema query parameter", () => {
    expect(pgConnectionString("postgresql://user:pass@localhost:5432/db?schema=workbench&sslmode=require"))
      .toBe("postgresql://user:pass@localhost:5432/db?sslmode=require");
  });

  it("creates and validates the external Import Source queue before accepting traffic", async () => {
    const manager = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      getQueue: vi.fn().mockResolvedValue({
        name: importSourceProcessQueue,
        ...importSourceProcessQueueOptions,
      }),
    };

    await expect(createAndAssertImportSourceQueue(manager as never)).resolves.toBeUndefined();

    expect(manager.createQueue).toHaveBeenCalledWith(
      importSourceProcessQueue,
      importSourceProcessQueueOptions,
    );
    expect(manager.getQueue).toHaveBeenCalledWith(importSourceProcessQueue);
  });

  it("fails startup when a persisted Import Source queue has stale options", async () => {
    const manager = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      getQueue: vi.fn().mockResolvedValue({
        name: importSourceProcessQueue,
        ...importSourceProcessQueueOptions,
        retryLimit: 3,
      }),
    };

    await expect(createAndAssertImportSourceQueue(manager as never))
      .rejects.toThrow("IMPORT_SOURCE_PROCESS_QUEUE_CONFIGURATION_MISMATCH:retryLimit");
  });
});
