"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isWorkbenchApiError } from "../../../api/problem-details";
import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import {
  useWorkbenchIdentityApi,
  type WorkbenchIdentityApi,
} from "../api-adapter";
import type {
  CommunicationPreferences,
  UpdateCommunicationPreferencesRequest,
} from "../domain";

export type WorkbenchIdentityReader = Pick<WorkbenchIdentityApi, "getIdentity">;

export function useWorkbenchIdentityReader(): WorkbenchIdentityReader {
  return useWorkbenchIdentityApi();
}

export function useWorkbenchIdentity() {
  const api = useWorkbenchIdentityApi();
  return useQuery({
    queryKey: workbenchQueryKeys.identity(),
    queryFn: () => api.getIdentity(),
  });
}

export function useWorkbenchCommunicationPreferences() {
  const api = useWorkbenchIdentityApi();
  return useQuery({
    queryKey: workbenchQueryKeys.communicationPreferences(),
    queryFn: () => api.getCommunicationPreferences(),
  });
}

export function useUpdateWorkbenchCommunicationPreferences() {
  const api = useWorkbenchIdentityApi();
  const queryClient = useQueryClient();
  const queryKey = workbenchQueryKeys.communicationPreferences();

  return useMutation({
    mutationFn: ({ request, ifMatch }: {
      request: UpdateCommunicationPreferencesRequest;
      ifMatch?: string;
    }) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<CommunicationPreferences>>(queryKey)?.etag;
      if (!etag) {
        throw new WorkbenchVersionRequiredError("communication preferences", "current principal");
      }
      return api.updateCommunicationPreferences(request, etag);
    },
    onSuccess(result) {
      queryClient.setQueryData(queryKey, result);
    },
    async onError(error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) return;
      await queryClient.refetchQueries({ queryKey, type: "all" });
    },
  });
}
