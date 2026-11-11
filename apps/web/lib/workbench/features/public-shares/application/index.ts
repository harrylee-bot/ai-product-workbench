"use client";

import type { CreateProjectRemixRequest, ExportSelection } from "@workbench/workbench-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCallback } from "react";

import { workbenchQueryKeys } from "../../../query/keys";
import { useWorkbenchPublicSharesApi } from "../api-adapter";
import { publicShareTokenScope } from "../domain";

export function useWorkbenchPublicShare(shareToken: string) {
  const service = useWorkbenchPublicSharesApi();
  const tokenScope = publicShareTokenScope(shareToken);
  return useQuery({
    queryKey: workbenchQueryKeys.publicShare(tokenScope),
    queryFn: () => service.getPublicShare(shareToken),
    enabled: Boolean(shareToken),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useWorkbenchPublicSharedArtifactVersion(
  shareToken: string,
  artifactId: string,
  artifactVersionId: string,
  enabled = true,
) {
  const service = useWorkbenchPublicSharesApi();
  const tokenScope = publicShareTokenScope(shareToken);
  return useQuery({
    queryKey: workbenchQueryKeys.publicSharedArtifactVersion(
      tokenScope,
      artifactId,
      artifactVersionId,
    ),
    queryFn: () => service.getPublicSharedArtifactVersion(
      shareToken,
      artifactId,
      artifactVersionId,
    ),
    enabled: enabled && Boolean(shareToken && artifactId && artifactVersionId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useWorkbenchPublicSharedArtifactAsset(
  shareToken: string,
  artifactId: string,
  artifactVersionId: string,
  assetId: string,
  enabled = true,
) {
  const service = useWorkbenchPublicSharesApi();
  const tokenScope = publicShareTokenScope(shareToken);
  return useQuery({
    queryKey: workbenchQueryKeys.publicSharedArtifactAsset(
      tokenScope,
      artifactId,
      artifactVersionId,
      assetId,
    ),
    queryFn: () => service.getPublicSharedArtifactVersionAssetContent(
      shareToken,
      artifactId,
      artifactVersionId,
      assetId,
    ),
    enabled: enabled && Boolean(shareToken && artifactId && artifactVersionId && assetId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useWorkbenchPublicSharedArtifactContent(
  shareToken: string,
  artifactId: string,
  artifactVersionId: string,
  enabled = true,
) {
  const service = useWorkbenchPublicSharesApi();
  const tokenScope = publicShareTokenScope(shareToken);
  return useQuery({
    queryKey: workbenchQueryKeys.publicSharedArtifactContent(
      tokenScope,
      artifactId,
      artifactVersionId,
    ),
    queryFn: () => service.getPublicSharedArtifactVersionContent(
      shareToken,
      artifactId,
      artifactVersionId,
    ),
    enabled: enabled && Boolean(shareToken && artifactId && artifactVersionId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCreateWorkbenchProjectRemix(shareToken: string) {
  const service = useWorkbenchPublicSharesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateProjectRemixRequest;
      idempotencyKey?: string;
    }) => service.createProjectRemix(shareToken, request, idempotencyKey),
    async onSuccess() {
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.projectLists(),
      });
    },
  });
}

export function useWorkbenchPublicSourcePrototypePreviewCreator(shareToken: string, artifactId: string, artifactVersionId: string) {
  const api = useWorkbenchPublicSharesApi();
  return useCallback((_selection: ExportSelection, signal?: AbortSignal) => (
    api.createSourcePrototypePreviewToken(shareToken, artifactId, artifactVersionId, signal)
  ), [api, shareToken, artifactId, artifactVersionId]);
}
