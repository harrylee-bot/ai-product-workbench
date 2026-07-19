"use client";

import {
  communicationPreferencesSchema,
  principalSchema,
  updateCommunicationPreferencesRequestSchema,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  normalizeEtag,
  parseContract,
  versioned,
  type Versioned,
} from "../../../transport/contracts";
import type {
  CommunicationPreferences,
  Principal,
  UpdateCommunicationPreferencesRequest,
} from "../domain";

export class WorkbenchIdentityApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async getIdentity(): Promise<Principal> {
    const result = await this.api.GET("/identity/me");
    return parseContract(principalSchema, result.data, "get identity");
  }

  async getCommunicationPreferences(): Promise<Versioned<CommunicationPreferences>> {
    const result = await this.api.GET("/identity/preferences");
    return versioned(
      communicationPreferencesSchema,
      result.data,
      result.response,
      "get communication preferences",
    );
  }

  async updateCommunicationPreferences(
    request: UpdateCommunicationPreferencesRequest,
    ifMatch: string,
  ): Promise<Versioned<CommunicationPreferences>> {
    const result = await this.api.PUT("/identity/preferences", {
      params: { header: { "If-Match": normalizeEtag(ifMatch) } },
      body: updateCommunicationPreferencesRequestSchema.parse(request),
    });
    return versioned(
      communicationPreferencesSchema,
      result.data,
      result.response,
      "update communication preferences",
    );
  }
}

export function useWorkbenchIdentityApi(): WorkbenchIdentityApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchIdentityApi(api), [api]);
}
