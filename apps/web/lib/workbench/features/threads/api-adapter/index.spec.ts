// @vitest-environment jsdom

import type {
  Thread,
  ThreadEntry,
} from "@workbench/workbench-contracts";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchTransportProvider } from "../../../transport/context";
import {
  useWorkbenchThreadsApi,
  WorkbenchThreadsApi,
} from "./index";

const timestamp = "2026-07-15T00:00:00.000Z";
const thread: Thread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Main thread",
  status: "active",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const entry: ThreadEntry = {
  id: "entry-1",
  threadId: thread.id,
  sequence: 1,
  role: "user",
  kind: "message",
  content: {
    protocol: "workbench.entry.v1",
    type: "user.prompt",
    text: "Build a dashboard",
    sourceIds: [],
  },
  producedByRunId: null,
  createdAt: timestamp,
};

describe("Threads API contracts", () => {
  it("keeps one feature-owned adapter instance across React rerenders", () => {
    const rendered = renderHook(() => useWorkbenchThreadsApi(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(
        WorkbenchTransportProvider,
        null,
        children,
      ),
    });
    const first = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(first);
    expect(first).toBeInstanceOf(WorkbenchThreadsApi);
    rendered.unmount();
  });

  it("owns Thread pagination, commands, ETags, and entries without a service facade", async () => {
    const requests: Request[] = [];
    const updated = { ...thread, title: "Renamed", revision: 2, updatedAt: timestamp };
    const api = createApi(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/projects/project-1/threads")) {
        expect(url.searchParams.get("cursor")).toBe("cursor-1");
        expect(url.searchParams.get("limit")).toBe("10");
        return Response.json({ items: [thread], nextCursor: "cursor-2" });
      }
      if (request.method === "POST" && url.pathname.endsWith("/projects/project-1/threads")) {
        return Response.json(thread, { status: 201, headers: { ETag: '"1"' } });
      }
      if (request.method === "GET" && url.pathname.endsWith("/threads/thread-1/entries")) {
        expect(url.searchParams.get("afterSequence")).toBe("1");
        expect(url.searchParams.get("limit")).toBe("20");
        return Response.json({ items: [entry], nextAfterSequence: 1 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/threads/thread-1")) {
        return Response.json(thread, { headers: { ETag: '"1"' } });
      }
      if (request.method === "PATCH" && url.pathname.endsWith("/threads/thread-1")) {
        return Response.json(updated, { headers: { ETag: '"2"' } });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/threads/thread-1")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });

    await expect(api.listThreads("project-1", { cursor: "cursor-1", limit: 10 }))
      .resolves.toEqual({ items: [thread], nextCursor: "cursor-2" });
    await expect(api.createThread("project-1", { title: "Main thread" }))
      .resolves.toEqual({ value: thread, etag: '"1"' });
    await expect(api.getThread(thread.id))
      .resolves.toEqual({ value: thread, etag: '"1"' });
    await expect(api.updateThread(thread.id, { title: "Renamed" }, '  "1"  '))
      .resolves.toEqual({ value: updated, etag: '"2"' });
    await expect(api.archiveThread(thread.id, '  "2"  ')).resolves.toBeUndefined();
    await expect(api.listThreadEntries(thread.id, { afterSequence: 1, limit: 20 }))
      .resolves.toEqual({ items: [entry], nextAfterSequence: 1 });

    const createRequest = requests.find((request) => request.method === "POST");
    const updateRequest = requests.find((request) => request.method === "PATCH");
    const archiveRequest = requests.find((request) => request.method === "DELETE");
    expect(createRequest?.headers.get("idempotency-key"))
      .toMatch(/^thread:[A-Za-z0-9_-]{24}$/);
    await expect(createRequest?.clone().json()).resolves.toEqual({ title: "Main thread" });
    expect(updateRequest?.headers.get("if-match")).toBe('"1"');
    await expect(updateRequest?.clone().json()).resolves.toEqual({ title: "Renamed" });
    expect(archiveRequest?.headers.get("if-match")).toBe('"2"');
  });

  it("rejects a structurally invalid Thread response", async () => {
    const api = createApi(async () => Response.json(
      { id: "thread-1" },
      { headers: { ETag: '"1"' } },
    ));

    await expect(api.getThread("thread-1")).rejects
      .toBeInstanceOf(WorkbenchContractError);
  });
});

function createApi(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchThreadsApi(createWorkbenchApiClient({
    baseUrl: `${window.location.origin}/api/v1`,
    fetch: vi.fn(fetch),
  }));
}
