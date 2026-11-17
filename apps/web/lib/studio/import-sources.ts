"use client";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useWorkbenchImportSourcesApi } from "./api";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { WorkbenchContractError } from "@/lib/workbench/transport/contracts";

export function useStudioImportSources(projectId: string, selectedIds: string[]) {
  const api = useWorkbenchImportSourcesApi();
  const list = useInfiniteQuery({
    queryKey: [...workbenchQueryKeys.importSources(projectId), "studio-directory"],
    queryFn: ({ pageParam }) => api.listImportSources(projectId, { cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: !!projectId,
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(item => !["ready", "failed"].includes(item.status))) ? 5000 : false,
  });
  const selected = useQueries({ queries: selectedIds.map(id => ({
    queryKey: workbenchQueryKeys.importSource(projectId, id),
    queryFn: async () => {
      const value = await api.getImportSource(id);
      if (value.value.id !== id || value.value.projectId !== projectId) throw new WorkbenchContractError("read selected import source");
      return value;
    },
    enabled: !!projectId,
    retry: false,
  })) });
  const invalidIds = selectedIds.filter((_, index) => {
    const result = selected[index]!;
    return isWorkbenchApiError(result.error) && [403, 404].includes(result.error.status)
      || !!result.data && result.data.value.status !== "ready";
  });
  const unverifiedIds = selectedIds.filter((id, index) => !invalidIds.includes(id) && (!selected[index]!.data || selected[index]!.isError));
  return {
    ...list,
    items: [...new Map((list.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()],
    selectedItems: selected.flatMap(item => item.data ? [item.data.value] : []),
    invalidIds,
    unverifiedIds,
    verificationFailed: selected.some(item => item.isError),
    retrySelected: () => Promise.all(selected.map(item => item.refetch())),
  };
}
