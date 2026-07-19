import { decodeRunCursor, encodeRunCursor, RunsService } from "../src/modules/runs/runs.service.js";

describe("Run cursor", () => {
  it("round-trips the stable newest-first boundary", () => {
    const cursor = { createdAt: "2026-07-12T00:00:00.000Z", id: "run_1" };
    expect(decodeRunCursor(encodeRunCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed or incomplete values", () => {
    expect(() => decodeRunCursor("not-base64-json")).toThrow();
    expect(() => decodeRunCursor(Buffer.from(JSON.stringify({ id: "run_1" })).toString("base64url")))
      .toThrow();
    for (const value of [
      { id: 42, createdAt: "2026-07-12T00:00:00.000Z" },
      { id: {}, createdAt: "2026-07-12T00:00:00.000Z" },
      { id: "run_1", createdAt: null },
      { id: "run_1", createdAt: "2026-07-12" },
      { id: "run_1", createdAt: "2026-07-12T00:00:00.000Z", extra: true },
    ]) {
      expect(() => decodeRunCursor(Buffer.from(JSON.stringify(value)).toString("base64url")))
        .toThrow();
    }
  });

  it("rejects an invalid cursor before authorization or list database access", async () => {
    const access = { findThread: vi.fn() };
    const db = { run: { findMany: vi.fn() } };
    const service = new RunsService(
      db as never,
      access as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.list("principal_1", "thread_1", "not-base64-json"))
      .rejects.toMatchObject({ status: 400 });
    expect(access.findThread).not.toHaveBeenCalled();
    expect(db.run.findMany).not.toHaveBeenCalled();
  });
});
