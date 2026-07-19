"use client";

import {
  runApprovalListSchema,
  runApprovalSchema,
  runListSchema,
  runSchema,
  submitApprovalResponseSchema,
  type Run,
  type RunApproval,
  type RunApprovalList,
  type RunList,
  type SubmitApprovalRequest,
  type SubmitApprovalResponse,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
  type CursorPageOptions,
  type Versioned,
} from "../../../transport/contracts";

export class WorkbenchRunsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listRuns(threadId: string, options: CursorPageOptions = {}): Promise<RunList> {
    const result = await this.api.GET("/threads/{threadId}/runs", {
      params: { path: { threadId }, query: options },
    });
    return parseContract(runListSchema, result.data, "list runs");
  }

  async getRun(runId: string): Promise<Run> {
    const result = await this.api.GET("/runs/{runId}", {
      params: { path: { runId } },
    });
    return parseContract(runSchema, result.data, "get run");
  }

  async cancelRun(
    runId: string,
    idempotencyKey = createIdempotencyKey("cancel"),
  ): Promise<Run> {
    const result = await this.api.POST("/runs/{runId}/cancel", {
      params: {
        path: { runId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
    });
    return parseContract(runSchema, result.data, "cancel run");
  }

  async retryRun(
    runId: string,
    idempotencyKey = createIdempotencyKey("retry"),
  ): Promise<Run> {
    const result = await this.api.POST("/runs/{runId}/retry", {
      params: {
        path: { runId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
    });
    return parseContract(runSchema, result.data, "retry run");
  }

  async listRunApprovals(runId: string): Promise<RunApprovalList> {
    const result = await this.api.GET("/runs/{runId}/approvals", {
      params: { path: { runId } },
    });
    return parseContract(runApprovalListSchema, result.data, "list run approvals");
  }

  async getRunApproval(runId: string, approvalId: string): Promise<Versioned<RunApproval>> {
    const result = await this.api.GET("/runs/{runId}/approvals/{approvalId}", {
      params: { path: { runId, approvalId } },
    });
    return versioned(runApprovalSchema, result.data, result.response, "get run approval");
  }

  async submitRunApproval(
    runId: string,
    approvalId: string,
    request: SubmitApprovalRequest,
    idempotencyKey = createIdempotencyKey("approval"),
  ): Promise<Versioned<SubmitApprovalResponse>> {
    const result = await this.api.POST("/runs/{runId}/approvals/{approvalId}", {
      params: {
        path: { runId, approvalId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      // openapi-fetch's exact-body helper cannot represent a recursive JSON value.
      body: request as never,
    });
    return versioned(
      submitApprovalResponseSchema,
      result.data,
      result.response,
      "submit run approval",
    );
  }
}

export function useWorkbenchRunsApi(): WorkbenchRunsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchRunsApi(api), [api]);
}
