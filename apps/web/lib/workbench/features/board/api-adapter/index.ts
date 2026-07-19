"use client";

import {
  boardSchema,
  type Board,
  type ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  normalizeEtag,
  normalizeIdempotencyKey,
  versioned,
  type Versioned,
} from "../../../transport/contracts";

export class WorkbenchBoardApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async getBoard(projectId: string): Promise<Versioned<Board>> {
    const result = await this.api.GET("/projects/{projectId}/board", {
      params: { path: { projectId } },
    });
    return versioned(boardSchema, result.data, result.response, "get board");
  }

  async replaceBoard(
    projectId: string,
    request: ReplaceBoardRequest,
    ifMatch: string,
    idempotencyKey: string,
  ): Promise<Versioned<Board>> {
    const result = await this.api.PUT("/projects/{projectId}/board", {
      params: {
        path: { projectId },
        header: {
          "If-Match": normalizeEtag(ifMatch),
          "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey),
        },
      },
      body: request,
    });
    return versioned(boardSchema, result.data, result.response, "replace board");
  }
}

export function useWorkbenchBoardApi(): WorkbenchBoardApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchBoardApi(api), [api]);
}
