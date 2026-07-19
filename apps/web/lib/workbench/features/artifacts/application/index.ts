"use client";

export * from "./preference-toggle-coordinator";

import type {
  Artifact,
  ArtifactVersionPreference,
  CreateArtifactRequest,
  CreateArtifactVersionRequest,
  UpdateArtifactVersionPreferenceRequest,
} from "@workbench/workbench-contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type CursorPageOptions,
  type Versioned,
} from "../../../transport/contracts";
import { useWorkbenchArtifactsApi } from "../api-adapter";
import type { ArtifactListOptions } from "../domain";

export function useWorkbenchArtifacts(
  projectId: string,
  options: ArtifactListOptions = {},
) {
  const api = useWorkbenchArtifactsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.artifactList(projectId, options),
    queryFn: () => api.listArtifacts(projectId, options),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export function useWorkbenchArtifact(projectId: string, artifactId: string) {
  const api = useWorkbenchArtifactsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.artifact(projectId, artifactId),
    queryFn: () => api.getArtifact(artifactId),
    enabled: Boolean(projectId && artifactId),
  });
}

export function useCreateWorkbenchArtifact(projectId: string) {
  const api = useWorkbenchArtifactsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.artifacts(projectId), "create"],
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateArtifactRequest;
      idempotencyKey?: string;
    }) => api.createArtifact(projectId, request, idempotencyKey),
    async onSuccess() {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.artifactLists(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.bootstraps(projectId),
        }),
      ]);
    },
  });
}

export function useCreateWorkbenchArtifactVersion(projectId: string, artifactId: string) {
  const api = useWorkbenchArtifactsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.artifact(projectId, artifactId), "versions", "create"],
    mutationFn: ({ request, ifMatch, idempotencyKey }: {
      request: CreateArtifactVersionRequest;
      ifMatch?: string;
      idempotencyKey?: string;
    }) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<Artifact>>(
          workbenchQueryKeys.artifact(projectId, artifactId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("artifact", artifactId);
      return api.createArtifactVersion(artifactId, request, etag, idempotencyKey);
    },
    async onSuccess() {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.artifact(projectId, artifactId),
        }),
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.artifactLists(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.bootstraps(projectId),
        }),
      ]);
    },
  });
}

export function useWorkbenchArtifactVersions(
  projectId: string,
  artifactId: string,
  options: CursorPageOptions = {},
) {
  const api = useWorkbenchArtifactsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.artifactVersionList(projectId, artifactId, options),
    queryFn: () => api.listArtifactVersions(artifactId, options),
    enabled: Boolean(projectId && artifactId),
    placeholderData: keepPreviousData,
  });
}

export function useInfiniteWorkbenchArtifactVersions(
  projectId: string,
  artifactId: string,
  options: Omit<CursorPageOptions, "cursor"> = {},
) {
  const api = useWorkbenchArtifactsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.artifactVersionInfiniteList(projectId, artifactId, options),
    queryFn: ({ pageParam }) => api.listArtifactVersions(artifactId, {
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(projectId && artifactId),
  });
}

export function useInfiniteWorkbenchArtifactVersionFavorites(
  projectId: string,
  options: Omit<CursorPageOptions, "cursor"> = {},
) {
  const api = useWorkbenchArtifactsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.artifactVersionFavoriteInfiniteList(projectId, options),
    queryFn: ({ pageParam }) => api.listArtifactVersionFavorites(projectId, {
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(projectId),
  });
}

export function useWorkbenchArtifactVersion(
  projectId: string,
  artifactId: string,
  artifactVersionId: string,
  enabled = true,
) {
  const api = useWorkbenchArtifactsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.artifactVersion(projectId, artifactId, artifactVersionId),
    queryFn: () => api.getArtifactVersion(artifactId, artifactVersionId),
    enabled: enabled && Boolean(projectId && artifactId && artifactVersionId),
  });
}

export function useWorkbenchArtifactVersionBatch(
  projectId: string,
  references: ReadonlyArray<{ artifactId: string; artifactVersionId: string }>,
  enabled = true,
) {
  const api = useWorkbenchArtifactsApi();
  return useQueries({
    queries: references.map(({ artifactId, artifactVersionId }) => ({
      queryKey: workbenchQueryKeys.artifactVersion(projectId, artifactId, artifactVersionId),
      queryFn: () => api.getArtifactVersion(artifactId, artifactVersionId),
      enabled: enabled && Boolean(projectId && artifactId && artifactVersionId),
    })),
  });
}

export function useWorkbenchArtifactVersionPreference(
  principalCacheNamespace: string,
  projectId: string,
  artifactId: string,
  artifactVersionId: string,
  screenId: string | null = null,
  enabled = true,
) {
  const api = useWorkbenchArtifactsApi();
  const queryClient = useQueryClient();
  const queryKey = workbenchQueryKeys.artifactVersionPreference(
    principalCacheNamespace,
    projectId,
    artifactId,
    artifactVersionId,
    screenId,
  );
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const cached = queryClient.getQueryData<Versioned<ArtifactVersionPreference>>(queryKey);
      const result = await api.getArtifactVersionPreference(
        artifactId,
        artifactVersionId,
        screenId,
        cached,
        signal,
      );
      return mergeArtifactVersionPreferenceCache(
        queryClient.getQueryData<Versioned<ArtifactVersionPreference>>(queryKey),
        result,
      );
    },
    enabled: enabled && Boolean(
      principalCacheNamespace && projectId && artifactId && artifactVersionId,
    ),
  });
}

export function useUpdateWorkbenchArtifactVersionPreference(
  principalCacheNamespace: string,
  projectId: string,
  artifactId: string,
  artifactVersionId: string,
  screenId: string | null = null,
) {
  const api = useWorkbenchArtifactsApi();
  const queryClient = useQueryClient();
  const queryKey = workbenchQueryKeys.artifactVersionPreference(
    principalCacheNamespace,
    projectId,
    artifactId,
    artifactVersionId,
    screenId,
  );

  return useMutation({
    mutationKey: [...queryKey, "update"],
    async onMutate() {
      await queryClient.cancelQueries({ queryKey, exact: true });
    },
    mutationFn: ({ request, ifMatch }: {
      request: UpdateArtifactVersionPreferenceRequest;
      ifMatch?: string;
    }) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<ArtifactVersionPreference>>(queryKey)?.etag;
      if (!etag) {
        throw new WorkbenchVersionRequiredError(
          "artifact version preference",
          artifactVersionId,
        );
      }
      return api.updateArtifactVersionPreference(
        artifactId,
        artifactVersionId,
        request,
        etag,
        screenId,
      );
    },
    async onSuccess(result) {
      queryClient.setQueryData<Versioned<ArtifactVersionPreference>>(
        queryKey,
        (current) => mergeArtifactVersionPreferenceCache(current, result),
      );
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.artifactVersionFavoriteLists(projectId),
      });
    },
    async onError() {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });
}

export function mergeArtifactVersionPreferenceCache(
  current: Versioned<ArtifactVersionPreference> | undefined,
  incoming: Versioned<ArtifactVersionPreference>,
): Versioned<ArtifactVersionPreference> {
  if (!current || incoming.value.revision > current.value.revision) return incoming;
  return current;
}

export function useWorkbenchArtifactVersionAsset(
  projectId: string,
  artifactId: string,
  artifactVersionId: string,
  assetId: string,
  enabled = true,
) {
  const api = useWorkbenchArtifactsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.artifactVersionAsset(
      projectId,
      artifactId,
      artifactVersionId,
      assetId,
    ),
    queryFn: () => api.getArtifactVersionAssetContent(
      artifactId,
      artifactVersionId,
      assetId,
    ),
    enabled: enabled && Boolean(projectId && artifactId && artifactVersionId && assetId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useWorkbenchArtifactVersionContent(
  projectId: string,
  artifactId: string,
  artifactVersionId: string,
  enabled = true,
) {
  const api = useWorkbenchArtifactsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.artifactVersionContent(
      projectId,
      artifactId,
      artifactVersionId,
    ),
    queryFn: () => api.getArtifactVersionContent(artifactId, artifactVersionId),
    enabled: enabled && Boolean(projectId && artifactId && artifactVersionId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
