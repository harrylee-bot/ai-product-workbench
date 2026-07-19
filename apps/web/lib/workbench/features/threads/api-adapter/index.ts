"use client";

import {
  threadEntryListSchema,
  threadListSchema,
  threadSchema,
  type CreateThreadRequest,
  type Thread,
  type ThreadEntryList,
  type ThreadList,
  type UpdateThreadRequest,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
  type CursorPageOptions,
  type Versioned,
} from "../../../transport/contracts";
import type { ThreadEntryPageOptions } from "../domain";

export class WorkbenchThreadsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listThreads(
    projectId: string,
    options: CursorPageOptions = {},
  ): Promise<ThreadList> {
    const result = await this.api.GET("/projects/{projectId}/threads", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(threadListSchema, result.data, "list threads");
  }

  async createThread(
    projectId: string,
    request: CreateThreadRequest,
    idempotencyKey = createIdempotencyKey("thread"),
  ): Promise<Versioned<Thread>> {
    const result = await this.api.POST("/projects/{projectId}/threads", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: request,
    });
    return versioned(threadSchema, result.data, result.response, "create thread");
  }

  async getThread(threadId: string): Promise<Versioned<Thread>> {
    const result = await this.api.GET("/threads/{threadId}", {
      params: { path: { threadId } },
    });
    return versioned(threadSchema, result.data, result.response, "get thread");
  }

  async updateThread(
    threadId: string,
    request: UpdateThreadRequest,
    ifMatch: string,
  ): Promise<Versioned<Thread>> {
    const result = await this.api.PATCH("/threads/{threadId}", {
      params: {
        path: { threadId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
      body: request,
    });
    return versioned(threadSchema, result.data, result.response, "update thread");
  }

  async archiveThread(threadId: string, ifMatch: string): Promise<void> {
    await this.api.DELETE("/threads/{threadId}", {
      params: {
        path: { threadId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
  }

  async listThreadEntries(
    threadId: string,
    options: ThreadEntryPageOptions = {},
  ): Promise<ThreadEntryList> {
    const result = await this.api.GET("/threads/{threadId}/entries", {
      params: { path: { threadId }, query: options },
    });
    return parseContract(threadEntryListSchema, result.data, "list thread entries");
  }
}

export function useWorkbenchThreadsApi(): WorkbenchThreadsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchThreadsApi(api), [api]);
}
