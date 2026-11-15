"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkbenchPrototypeSharesApi } from "../api-adapter";

export function useWorkbenchPublicPrototypeShare(token: string) {
  const service = useWorkbenchPrototypeSharesApi();
  return useQuery({
    queryKey: ["workbench", "public-prototype-share", token],
    queryFn: () => service.getPublicShare(token),
    enabled: Boolean(token),
    staleTime: 1_000,
    refetchInterval: (query) => query.state.status === "error" ? false : 2_000,
    retry: false,
  });
}
