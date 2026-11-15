"use client";
import {
  useInfiniteQuery,
} from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useWorkbenchDesignSystemsApi,
  type WorkbenchDesignSystemsApi,
} from "../api-adapter";
import type { DesignSystemCatalogOptions } from "../domain";

export type WorkbenchDesignSystemOperations = Pick<
  WorkbenchDesignSystemsApi,
  "createDesignSystem" | "importDesignSystem"
>;

export function useWorkbenchDesignSystemOperations(): WorkbenchDesignSystemOperations {
  return useWorkbenchDesignSystemsApi();
}

export function useInfiniteWorkbenchDesignSystemCatalog(
  workspaceId: string,
  options: Omit<DesignSystemCatalogOptions, "cursor"> = {},
) {
  const api = useWorkbenchDesignSystemsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.designSystemInfiniteCatalog(workspaceId, options),
    queryFn: ({ pageParam }) => api.listDesignSystemCatalog(workspaceId, {
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
  });
}
