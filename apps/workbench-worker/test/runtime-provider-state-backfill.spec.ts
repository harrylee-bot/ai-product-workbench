import {
  createRuntimeProviderProjection,
  sha256Canonical,
} from "../src/runtime/runtime-assistant-text.js";
import {
  RuntimeProviderStateBackfill,
  runtimeProviderStateBackfillEventPageSize,
} from "../src/runtime/runtime-provider-state-backfill.js";

describe("RuntimeProviderStateBackfill coverage", () => {
  it("blocks rollout for every missing expected projection, including terminal attempts", async () => {
    const projection = createRuntimeProviderProjection({
      runtimeAttemptId: "attempt-built",
      runId: "run-built",
    });
    const db = {
      runtimeAttempt: {
        findMany: vi.fn(async () => [
          {
            id: "attempt-built",
            runId: "run-built",
            status: "running",
            externalEventSequence: 0,
            providerState: projection,
          },
          {
            id: "attempt-waiting",
            runId: "run-waiting",
            status: "waiting_input",
            externalEventSequence: 0,
            providerState: null,
          },
          {
            id: "attempt-terminal",
            runId: "run-terminal",
            status: "succeeded",
            externalEventSequence: 1,
            providerState: null,
          },
        ]),
      },
    };

    await expect(new RuntimeProviderStateBackfill(db as never).coverage()).resolves.toEqual({
      totalAttempts: 3,
      expectedProjections: 3,
      built: 1,
      verified: 1,
      missing: 2,
      conflicts: 0,
      lagging: 0,
      versionMismatch: 0,
      hashMismatch: 0,
      activeMissing: 1,
      terminalMissing: 1,
      rolloutBlocked: true,
    });
  });
});

describe("RuntimeProviderStateBackfill transaction boundary", () => {
  it("replays historical event payloads before opening the short write transaction", async () => {
    const fixture = backfillDatabase();

    const result = await new RuntimeProviderStateBackfill(fixture.db as never).processPage({
      candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
      mode: "apply",
      batchSize: 1,
    });

    expect(result.checkpoints[0]).toMatchObject({
      eventCount: 0,
      lastSequence: 0,
      status: "created",
    });
    expect(fixture.order.indexOf("history-replay")).toBeLessThan(
      fixture.order.indexOf("transaction-open"),
    );
    expect(fixture.transactionOptions()).toEqual({ maxWait: 10_000, timeout: 5_000 });
    expect(fixture.createProjection).toHaveBeenCalledTimes(1);
  });

  it("rejects a target that advances after the offline replay snapshot", async () => {
    const fixture = backfillDatabase({ lockedExternalEventSequence: 1 });

    await expect(new RuntimeProviderStateBackfill(fixture.db as never).processPage({
      candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
      mode: "apply",
      batchSize: 1,
    })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_BACKFILL_SNAPSHOT_CONFLICT/u);
    expect(fixture.createProjection).not.toHaveBeenCalled();
  });

  it("keyset-pages a large attempt outside the write transaction", async () => {
    const eventCount = runtimeProviderStateBackfillEventPageSize + 1;
    const fixture = paginatedBackfillDatabase(eventCount);

    const result = await new RuntimeProviderStateBackfill(fixture.db as never).processPage({
      candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
      mode: "apply",
      batchSize: 1,
    });

    expect(result.checkpoints[0]).toMatchObject({
      eventCount,
      lastSequence: eventCount,
      status: "created",
    });
    expect(fixture.eventPages).toHaveLength(2);
    expect(fixture.eventPages.every((page) => page.take === runtimeProviderStateBackfillEventPageSize))
      .toBe(true);
    expect(fixture.order.lastIndexOf("event-page")).toBeLessThan(
      fixture.order.indexOf("transaction-open"),
    );
    expect(fixture.transactionEventReads).toBe(0);
  });

  it("seeds each later attempt from the preceding projection without replaying earlier events", async () => {
    const fixture = multiAttemptBackfillDatabase();

    const result = await new RuntimeProviderStateBackfill(fixture.db as never).processPage({
      candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
      mode: "apply",
      batchSize: 2,
    });

    expect(result.checkpoints).toHaveLength(2);
    expect(result.checkpoints.map((checkpoint) => checkpoint.lastSequence)).toEqual([1, 1]);
    expect(fixture.eventReads).toEqual(["attempt-1", "attempt-2"]);
    expect(fixture.createdProjectionIds).toEqual(["attempt-1", "attempt-2"]);
  });
});

function backfillDatabase({ lockedExternalEventSequence = 0 } = {}) {
  const order: string[] = [];
  const attempt = {
    id: "attempt-target",
    runId: "run-target",
    attempt: 1,
    externalEventSequence: 0,
    status: "running",
  };
  const createProjection = vi.fn(async () => undefined);
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    order.push("transaction-open");
    return callback({
      $queryRaw: vi.fn(async () => [{
        ...attempt,
        externalEventSequence: lockedExternalEventSequence,
      }]),
      runDraft: {
        findUnique: vi.fn(async () => null),
      },
      runtimeAttempt: {
        findFirst: vi.fn(async () => ({ id: attempt.id })),
      },
      runtimeProviderState: {
        create: createProjection,
        findUnique: vi.fn(async () => null),
      },
    });
  });
  const db = {
    $transaction: transaction,
    runtimeAttempt: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => {
        order.push("page-read");
        return [{ id: attempt.id }];
      }),
      findUnique: vi.fn(async () => {
        order.push("target-snapshot");
        return attempt;
      }),
    },
    runtimeExternalEvent: {
      findFirst: vi.fn(async () => {
        order.push("history-replay");
        return null;
      }),
      findMany: vi.fn(async () => []),
    },
  };
  return {
    createProjection,
    db,
    order,
    transactionOptions: () => transaction.mock.calls[0]?.[1],
  };
}

function paginatedBackfillDatabase(eventCount: number) {
  const order: string[] = [];
  const eventPages: Array<{ afterSequence: number; take: number }> = [];
  const attempt = {
    id: "attempt-paginated",
    runId: "run-paginated",
    attempt: 1,
    externalEventSequence: eventCount,
    status: "succeeded",
  };
  const payload = { synthetic: true };
  const events = Array.from({ length: eventCount }, (_, index) => ({
    externalEventId: `event-${index + 1}`,
    sequence: index + 1,
    event: "synthetic.noop",
    payload,
    payloadSha256: sha256Canonical(payload),
    status: "processed",
  }));
  let transactionEventReads = 0;
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      order.push("transaction-open");
      return callback({
        $queryRaw: vi.fn(async () => [attempt]),
        runDraft: { findUnique: vi.fn(async () => null) },
        runtimeAttempt: {
          findFirst: vi.fn(async () => ({ id: attempt.id })),
        },
        runtimeExternalEvent: {
          findMany: vi.fn(async () => {
            transactionEventReads += 1;
            return [];
          }),
        },
        runtimeProviderState: {
          create: vi.fn(async () => undefined),
          findUnique: vi.fn(async () => null),
        },
      });
    }),
    runtimeAttempt: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [{ id: attempt.id }]),
      findUnique: vi.fn(async () => attempt),
    },
    runtimeExternalEvent: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (query: {
        take: number;
        where: { sequence: { gt: number } };
      }) => {
        order.push("event-page");
        const afterSequence = query.where.sequence.gt;
        eventPages.push({ afterSequence, take: query.take });
        return events.slice(afterSequence, afterSequence + query.take);
      }),
    },
  };
  return {
    db,
    eventPages,
    order,
    get transactionEventReads() {
      return transactionEventReads;
    },
  };
}

function multiAttemptBackfillDatabase() {
  const payload = { synthetic: true };
  const attempts = [1, 2].map((attempt) => ({
    id: `attempt-${attempt}`,
    runId: "run-multiple",
    attempt,
    externalEventSequence: 1,
    status: "succeeded",
  }));
  const projections = new Map<string, ReturnType<typeof createRuntimeProviderProjection>>();
  const eventReads: string[] = [];
  const createdProjectionIds: string[] = [];
  let targetIndex = 0;
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const target = attempts[targetIndex]!;
      const result = await callback({
        $queryRaw: vi.fn(async () => [target]),
        runDraft: { findUnique: vi.fn(async () => null) },
        runtimeAttempt: {
          findFirst: vi.fn(async () => ({ id: attempts[1]!.id })),
          findUnique: vi.fn(async () => ({
            externalEventSequence: attempts[0]!.externalEventSequence,
            providerState: projections.get(attempts[0]!.id) ?? null,
          })),
        },
        runtimeProviderState: {
          create: vi.fn(async ({ data }: { data: ReturnType<typeof createRuntimeProviderProjection> }) => {
            projections.set(data.runtimeAttemptId, data);
            createdProjectionIds.push(data.runtimeAttemptId);
          }),
          findUnique: vi.fn(async () => projections.get(target.id) ?? null),
        },
      });
      targetIndex += 1;
      return result;
    }),
    runtimeAttempt: {
      findFirst: vi.fn(async (query: { where: { attempt: { lt: number } } }) => {
        if (query.where.attempt.lt === 1) return null;
        return {
          ...attempts[0]!,
          providerState: projections.get(attempts[0]!.id) ?? null,
        };
      }),
      findMany: vi.fn(async () => attempts.map(({ id }) => ({ id }))),
      findUnique: vi.fn(async () => attempts[targetIndex] ?? null),
    },
    runtimeExternalEvent: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (query: { where: { runtimeAttemptId: string } }) => {
        eventReads.push(query.where.runtimeAttemptId);
        return [{
          externalEventId: `${query.where.runtimeAttemptId}-event-1`,
          sequence: 1,
          event: "synthetic.noop",
          payload,
          payloadSha256: sha256Canonical(payload),
          status: "processed",
        }];
      }),
    },
  };
  return { createdProjectionIds, db, eventReads };
}
