import { forbiddenProblem } from "../src/common/problem-details.js";
import { canonicalJson, hashRequest } from "../src/common/idempotency.js";
import { parseAfterSequence, parseLimit } from "../src/modules/threads/threads.controller.js";
import {
  decodeThreadCursor,
  encodeThreadCursor,
  ThreadsService,
} from "../src/modules/threads/threads.service.js";

const thread = {
  id: "thread_1",
  projectId: "project_1",
  createdById: "principal_1",
  title: "Main",
  status: "active" as const,
  revision: 0,
  entrySequence: 0,
  idempotencyKey: "thread:key:123",
  requestHash: hashRequest({ title: "Main" }),
  createdAt: new Date("2026-07-12T00:00:00.000Z"),
  updatedAt: new Date("2026-07-12T00:00:00.000Z"),
};

describe("Thread management", () => {
  it("uses canonical request hashes and stable cursors", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(hashRequest({ title: "Main", metadata: { b: 2, a: 1 } }))
      .toBe(hashRequest({ metadata: { a: 1, b: 2 }, title: "Main" }));
    const cursor = { updatedAt: "2026-07-12T00:00:00.000Z", id: "thread_1" };
    expect(decodeThreadCursor(encodeThreadCursor(cursor))).toEqual(cursor);
    expect(() => decodeThreadCursor("bad-cursor")).toThrow();
  });

  it("strictly validates sequence and limit query values", () => {
    expect(parseAfterSequence(undefined)).toBe(0);
    expect(parseAfterSequence("12")).toBe(12);
    expect(parseLimit("100", 100)).toBe(100);
    expect(() => parseAfterSequence("-1")).toThrow();
    expect(() => parseAfterSequence("1.5")).toThrow();
    expect(() => parseLimit("101", 100)).toThrow();
  });

  it("does not query Threads when project access is denied", async () => {
    const db = { thread: { findMany: vi.fn() } };
    const access = { findProject: vi.fn().mockRejectedValue(forbiddenProblem()) };
    const service = new ThreadsService(db as never, access as never);

    await expect(service.list("principal_2", "project_1")).rejects.toThrow();
    expect(db.thread.findMany).not.toHaveBeenCalled();
  });

  it("replays an identical create command and rejects key reuse", async () => {
    const db = { thread: { findUnique: vi.fn().mockResolvedValue(thread) } };
    const access = { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) };
    const service = new ThreadsService(db as never, access as never);

    await expect(service.create("principal_1", "project_1", "thread:key:123", { title: "Main" }))
      .resolves.toMatchObject({ id: "thread_1", title: "Main" });
    await expect(service.create("principal_1", "project_1", "thread:key:123", { title: "Other" }))
      .rejects.toMatchObject({ status: 409 });
  });
});
