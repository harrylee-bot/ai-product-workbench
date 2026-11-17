"use client";
import { useMemo } from "react";
import { z } from "zod";
import {
  createRequirementSessionRequestSchema,
  postRequirementMessageRequestSchema,
  confirmRequirementRequestSchema,
  requirementSessionSchema,
  requirementSessionsSchema,
} from "@workbench/workbench-contracts";
import type { WorkbenchApiClient } from "@/lib/workbench/api/client";
import { useWorkbenchTransport } from "@/lib/workbench/transport/context";
import {
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
} from "@/lib/workbench/transport/contracts";

export class StudioRequirementApi {
  constructor(private readonly api: WorkbenchApiClient) {}
  async list(
    threadId: string,
    query: { cursor?: string; limit?: number } = {},
  ) {
    const r = await this.api.GET("/threads/{threadId}/requirement-sessions", {
      params: { path: { threadId }, query },
    });
    return parseContract(
      requirementSessionsSchema,
      r.data,
      "list requirement discussions",
    );
  }
  async get(sessionId: string) {
    const r = await this.api.GET("/requirement-sessions/{sessionId}", {
      params: { path: { sessionId } },
    });
    return versioned(
      requirementSessionSchema,
      r.data,
      r.response,
      "read requirement discussion",
    );
  }
  async create(
    threadId: string,
    request: z.input<typeof createRequirementSessionRequestSchema>,
    key: string,
  ) {
    const r = await this.api.POST("/threads/{threadId}/requirement-sessions", {
      params: {
        path: { threadId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(key) },
      },
      body: createRequirementSessionRequestSchema.parse(request),
    });
    return versioned(
      requirementSessionSchema,
      r.data,
      r.response,
      "create requirement discussion",
    );
  }
  async message(
    sessionId: string,
    request: z.input<typeof postRequirementMessageRequestSchema>,
    etag: string,
    key: string,
  ) {
    const r = await this.api.POST(
      "/requirement-sessions/{sessionId}/messages",
      {
        params: {
          path: { sessionId },
          header: {
            "If-Match": normalizeEtag(etag),
            "Idempotency-Key": normalizeIdempotencyKey(key),
          },
        },
        body: postRequirementMessageRequestSchema.parse(request),
      },
    );
    return versioned(
      requirementSessionSchema,
      r.data,
      r.response,
      "send requirement message",
    );
  }
  async confirm(
    sessionId: string,
    request: z.input<typeof confirmRequirementRequestSchema>,
    etag: string,
    key: string,
  ) {
    const r = await this.api.POST("/requirement-sessions/{sessionId}/confirm", {
      params: {
        path: { sessionId },
        header: {
          "If-Match": normalizeEtag(etag),
          "Idempotency-Key": normalizeIdempotencyKey(key),
        },
      },
      body: confirmRequirementRequestSchema.parse(request),
    });
    return versioned(
      requirementSessionSchema,
      r.data,
      r.response,
      "confirm requirement baseline",
    );
  }
  async retryConfirmation(
    sessionId: string,
    confirmationId: string,
    etag: string,
    key: string,
  ) {
    const r = await this.api.POST(
      "/requirement-sessions/{sessionId}/confirmations/{confirmationId}/retry",
      {
        params: {
          path: { sessionId, confirmationId },
          header: {
            "If-Match": normalizeEtag(etag),
            "Idempotency-Key": normalizeIdempotencyKey(key),
          },
        },
      },
    );
    return versioned(
      requirementSessionSchema,
      r.data,
      r.response,
      "retry confirmed generation",
    );
  }
  async turn(
    action: "cancel" | "retry",
    sessionId: string,
    turnId: string,
    etag: string,
    key: string,
  ) {
    const params = {
      path: { sessionId, turnId },
      header: {
        "If-Match": normalizeEtag(etag),
        "Idempotency-Key": normalizeIdempotencyKey(key),
      },
    };
    const r =
      action === "cancel"
        ? await this.api.POST(
            "/requirement-sessions/{sessionId}/turns/{turnId}/cancel",
            { params },
          )
        : await this.api.POST(
            "/requirement-sessions/{sessionId}/turns/{turnId}/retry",
            { params },
          );
    return versioned(
      requirementSessionSchema,
      r.data,
      r.response,
      "update requirement analysis",
    );
  }
}
export function useStudioRequirementApi() {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new StudioRequirementApi(api), [api]);
}
