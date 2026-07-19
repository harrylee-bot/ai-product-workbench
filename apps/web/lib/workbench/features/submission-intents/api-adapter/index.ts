"use client";

import {
  createSubmissionIntentRequestSchema,
  currentSubmissionIntentSchema,
  submissionIntentSchema,
  submitSubmissionIntentResponseSchema,
  type CurrentSubmissionIntent,
  type SubmissionIntent,
  type SubmitSubmissionIntentResponse,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";
import type { z } from "zod";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
  type Versioned,
} from "../../../transport/contracts";

export type CreateSubmissionIntentInput = z.input<typeof createSubmissionIntentRequestSchema>;

export class WorkbenchSubmissionIntentsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async createSubmissionIntent(
    threadId: string,
    request: CreateSubmissionIntentInput,
    idempotencyKey = createIdempotencyKey("submission-intent"),
  ): Promise<Versioned<SubmissionIntent>> {
    const result = await this.api.POST("/threads/{threadId}/submission-intents", {
      params: {
        path: { threadId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: createSubmissionIntentRequestSchema.parse(request),
    });
    return versioned(
      submissionIntentSchema,
      result.data,
      result.response,
      "create submission intent",
    );
  }

  async getCurrentSubmissionIntent(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<CurrentSubmissionIntent> {
    const result = await this.api.GET("/threads/{threadId}/submission-intents/current", {
      params: { path: { threadId } },
      signal,
    });
    return parseContract(
      currentSubmissionIntentSchema,
      result.data,
      "get current submission intent",
    );
  }

  async getSubmissionIntent(intentId: string): Promise<Versioned<SubmissionIntent>> {
    const result = await this.api.GET("/submission-intents/{intentId}", {
      params: { path: { intentId } },
    });
    return versioned(
      submissionIntentSchema,
      result.data,
      result.response,
      "get submission intent",
    );
  }

  async submitSubmissionIntent(
    intentId: string,
  ): Promise<Versioned<SubmitSubmissionIntentResponse>> {
    const result = await this.api.POST("/submission-intents/{intentId}/submit", {
      params: { path: { intentId } },
    });
    return versioned(
      submitSubmissionIntentResponseSchema,
      result.data,
      result.response,
      "submit submission intent",
    );
  }

  async cancelSubmissionIntent(intentId: string, ifMatch: string): Promise<void> {
    await this.api.DELETE("/submission-intents/{intentId}", {
      params: {
        path: { intentId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
  }
}

export function useWorkbenchSubmissionIntentsApi(): WorkbenchSubmissionIntentsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchSubmissionIntentsApi(api), [api]);
}
