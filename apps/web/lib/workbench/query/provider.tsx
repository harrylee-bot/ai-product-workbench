"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
  type QueryClientConfig,
} from "@tanstack/react-query";
import {
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isWorkbenchApiError } from "../api/problem-details";

const DEFAULT_STALE_TIME_MS = 30_000;

export function createWorkbenchQueryClient(config: QueryClientConfig = {}): QueryClient {
  return new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
        ...config.defaultOptions?.queries,
      },
      mutations: {
        retry: false,
        ...config.defaultOptions?.mutations,
      },
    },
  });
}

export function WorkbenchQueryProvider({
  children,
  privateCacheNamespace,
  queryClient,
}: {
  children: ReactNode;
  privateCacheNamespace?: string | null;
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? createWorkbenchQueryClient());
  return (
    <QueryClientProvider client={client}>
      {privateCacheNamespace !== undefined ? (
        <WorkbenchPrivateQueryCacheBoundary cacheNamespace={privateCacheNamespace} />
      ) : null}
      {children}
    </QueryClientProvider>
  );
}

const uninitializedCacheNamespace = Symbol("uninitialized-cache-namespace");

export function WorkbenchPrivateQueryCacheBoundary({
  cacheNamespace,
}: {
  cacheNamespace: string | null;
}) {
  const queryClient = useQueryClient();
  const previous = useRef<string | null | typeof uninitializedCacheNamespace>(
    uninitializedCacheNamespace,
  );
  useLayoutEffect(() => {
    if (
      previous.current !== uninitializedCacheNamespace
      && previous.current !== cacheNamespace
    ) {
      queryClient.clear();
    }
    previous.current = cacheNamespace;
  }, [cacheNamespace, queryClient]);
  return null;
}

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (isWorkbenchApiError(error)) return error.retryable && failureCount < 2;
  return failureCount < 2;
}
