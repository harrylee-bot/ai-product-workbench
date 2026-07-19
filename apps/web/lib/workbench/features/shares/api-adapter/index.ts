"use client";

import {
  revokeProjectShareGrantsResponseSchema,
  rotateShareGrantRequestSchema,
  rotateShareGrantResponseSchema,
  shareGrantListSchema,
  shareGrantSchema,
  type RevokeProjectShareGrantsResponse,
  type RotateShareGrantRequest,
  type RotateShareGrantResponse,
  type ShareGrant,
  type ShareGrantList,
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

export class WorkbenchSharesApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listShareGrants(
    projectId: string,
    options: CursorPageOptions = {},
  ): Promise<ShareGrantList> {
    const result = await this.api.GET("/projects/{projectId}/shares", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(shareGrantListSchema, result.data, "list share grants");
  }

  async rotateShareGrant(
    projectId: string,
    request: RotateShareGrantRequest,
    idempotencyKey = createIdempotencyKey("share-rotate"),
  ): Promise<Versioned<RotateShareGrantResponse>> {
    const result = await this.api.POST("/projects/{projectId}/shares/rotate", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: rotateShareGrantRequestSchema.parse(request),
    });
    return versioned(
      rotateShareGrantResponseSchema,
      result.data,
      result.response,
      "rotate share grant",
    );
  }

  async revokeProjectShareGrants(
    projectId: string,
  ): Promise<RevokeProjectShareGrantsResponse> {
    const result = await this.api.POST("/projects/{projectId}/shares/revoke-all", {
      params: { path: { projectId } },
    });
    return parseContract(
      revokeProjectShareGrantsResponseSchema,
      result.data,
      "revoke Project share grants",
    );
  }

  async getShareGrant(shareId: string): Promise<Versioned<ShareGrant>> {
    const result = await this.api.GET("/shares/{shareId}", {
      params: { path: { shareId } },
    });
    return versioned(shareGrantSchema, result.data, result.response, "get share grant");
  }

  async revokeShareGrant(
    shareId: string,
    ifMatch: string,
  ): Promise<Versioned<ShareGrant>> {
    const result = await this.api.POST("/shares/{shareId}/revoke", {
      params: {
        path: { shareId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
    return versioned(
      shareGrantSchema,
      result.data,
      result.response,
      "revoke share grant",
    );
  }
}

export function useWorkbenchSharesApi(): WorkbenchSharesApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchSharesApi(api), [api]);
}
