"use client";

import { useQuery } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import { useWorkbenchDesignPresetsApi } from "../api-adapter";

export function useWorkbenchDesignPresets() {
  const api = useWorkbenchDesignPresetsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.designPresets(),
    queryFn: () => api.listDesignPresets(),
    staleTime: 5 * 60 * 1_000,
  });
}
