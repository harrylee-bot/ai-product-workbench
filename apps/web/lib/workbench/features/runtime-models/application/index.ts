"use client";

import { useQuery } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useWorkbenchRuntimeModelsApi,
  type WorkbenchRuntimeModelsApi,
} from "../api-adapter";

export type WorkbenchRuntimeModelsQueryPort = Pick<
  WorkbenchRuntimeModelsApi,
  "listRuntimeModels"
>;

export function runtimeModelsQueryOptions(api: WorkbenchRuntimeModelsQueryPort) {
  return {
    queryKey: workbenchQueryKeys.runtimeModels(),
    queryFn: () => api.listRuntimeModels(),
  } as const;
}

export function useWorkbenchRuntimeModels() {
  const api = useWorkbenchRuntimeModelsApi();
  return useQuery(runtimeModelsQueryOptions(api));
}
