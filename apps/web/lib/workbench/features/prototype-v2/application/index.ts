"use client";

import type {
  CreatePrototypeFeedbackRequest,
  CreatePrototypePlanRequest,
  CreatePrototypeShareRequest,
  CreatePrototypeExportRequest,
  PrototypeWorkflowActionRequest,
  RevisePrototypeRevisionRequest,
} from "@workbench/workbench-contracts";
import { useMutation, useQuery, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { workbenchQueryKeys } from "../../../query/keys";
import { createIdempotencyKey } from "../../../transport/contracts";
import { useWorkbenchPrototypeV2Api } from "../api-adapter";

export function useWorkbenchPrototypeV2Plan(projectId: string, planId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: workbenchQueryKeys.prototypeV2Plan(projectId, planId),
    queryFn: () => api.getPlan(projectId, planId),
    enabled: Boolean(projectId && planId),
    refetchInterval: (query) => ["ready", "failed", "cancelled"].includes(query.state.data?.value.status ?? "") ? false : 2_000,
  });
  const status = query.data?.value.status;
  useEffect(() => {
    if (status !== "ready") return;
    // Default generation can also publish a PRD; refresh the ordinary project
    // surfaces so returning from the V2 preview exposes every persisted output.
    client.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) });
    client.invalidateQueries({ queryKey: workbenchQueryKeys.artifactLists(projectId) });
    client.invalidateQueries({ queryKey: workbenchQueryKeys.board(projectId) });
  }, [client, planId, projectId, status]);
  return query;
}

export function useWorkbenchPrototypeV2Revisions(projectId: string, planId: string, enabled = true) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({
    queryKey: workbenchQueryKeys.prototypeV2Revisions(projectId, planId),
    queryFn: () => api.listRevisions(projectId, planId),
    enabled: enabled && Boolean(projectId && planId),
    refetchInterval: 3_000,
  });
}

export function useCreateWorkbenchPrototypeV2Plan(projectId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(projectId, {
    mutationFn: ({ request, idempotencyKey }: { request: CreatePrototypePlanRequest; idempotencyKey?: string }) => api.createPlan(projectId, request, idempotencyKey ?? createIdempotencyKey("prototype-plan")),
    onSuccess: (result) => { queryClient.setQueryData(workbenchQueryKeys.prototypeV2Plan(projectId, result.value.id), result); },
  });
}

export function useCreateWorkbenchPrototypeV2PreviewToken(projectId: string, revisionId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useMutation({ mutationFn: () => api.createPreviewToken(projectId, revisionId) });
}

export function usePrototypeV2PlanAction(projectId: string, planId: string, action: "approve" | "cancel") {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${planId}:${action}`, {
    mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => action === "approve"
      ? api.approvePlan(projectId, planId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-approve"))
      : api.cancelPlan(projectId, planId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-cancel")),
    onSuccess: (result) => { queryClient.setQueryData(workbenchQueryKeys.prototypeV2Plan(projectId, planId), result); queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); },
  });
}

export function useReviewWorkbenchPrototypeV2Revision(projectId: string, revisionId: string, action: "confirm" | "reject") {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${revisionId}:${action}`, {
    mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => action === "confirm"
      ? api.confirmRevision(projectId, revisionId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-confirm"))
      : api.rejectRevision(projectId, revisionId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-reject")),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); },
  });
}

export function useCreateWorkbenchPrototypeV2Feedback(projectId: string, revisionId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${revisionId}`, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); }, mutationFn: ({ request, idempotencyKey }: { request: CreatePrototypeFeedbackRequest; idempotencyKey?: string }) => api.createFeedback(projectId, revisionId, request, idempotencyKey ?? createIdempotencyKey("prototype-feedback")) });
}

export function useResolveWorkbenchPrototypeV2Feedback(projectId: string, feedbackId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${feedbackId}`, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); }, mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => api.resolveFeedback(projectId, feedbackId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-feedback-resolve")) });
}

export function useCreateWorkbenchPrototypeV2Share(projectId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(projectId, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); }, mutationFn: ({ request, idempotencyKey }: { request: CreatePrototypeShareRequest; idempotencyKey?: string }) => api.createShare(projectId, request, idempotencyKey ?? createIdempotencyKey("prototype-share")) });
}

export function useRevokeWorkbenchPrototypeV2Share(projectId: string, shareId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${shareId}`, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); }, mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => api.revokeShare(projectId, shareId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-share-revoke")) });
}

export function useCreateWorkbenchPrototypeV2Export(projectId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(projectId, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); }, mutationFn: ({ request, idempotencyKey }: { request: CreatePrototypeExportRequest; idempotencyKey?: string }) => api.createExport(projectId, request, idempotencyKey ?? createIdempotencyKey("prototype-export")) });
}

export function useWorkbenchPrototypeV2Export(projectId: string, exportId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({
    queryKey: workbenchQueryKeys.prototypeV2Export(projectId, exportId),
    queryFn: () => api.getExport(projectId, exportId),
    enabled: Boolean(projectId && exportId),
    refetchInterval: (query) => ["succeeded", "failed", "cancelled"].includes(query.state.data?.value.status ?? "") ? false : 3_000,
  });
}

export function useRetryWorkbenchPrototypeV2Export(projectId: string, exportId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${exportId}`, {
    mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => api.retryExport(projectId, exportId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-export-retry")),
    onSuccess: (result) => { queryClient.setQueryData(workbenchQueryKeys.prototypeV2Export(projectId, exportId), result); queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); },
  });
}

export function useCancelWorkbenchPrototypeV2Export(projectId: string, exportId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const queryClient = useQueryClient();
  return usePrototypeMutation(`${projectId}:${exportId}`, {
    mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => api.cancelExport(projectId, exportId, ifMatch, request, idempotencyKey ?? createIdempotencyKey("prototype-export-cancel")),
    onSuccess: (result) => { queryClient.setQueryData(workbenchQueryKeys.prototypeV2Export(projectId, exportId), result); queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); },
  });
}

export function useDownloadWorkbenchPrototypeV2Export(projectId: string, exportId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useMutation({
    mutationFn: () => api.downloadExport(projectId, exportId),
  });
}

export function useWorkbenchPrototypeV2Plans(projectId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({ queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "plans"], queryFn: () => api.listPlans(projectId), enabled: Boolean(projectId), refetchInterval: 3_000 });
}

export function useWorkbenchPrototypeV2Revision(projectId: string, revisionId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({ queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "revision", revisionId], queryFn: () => api.getRevision(projectId, revisionId), enabled: Boolean(projectId && revisionId) });
}

export function useWorkbenchPrototypeV2Feedback(projectId: string, revisionId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({ queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "feedback", revisionId], queryFn: () => api.listFeedback(projectId, revisionId), enabled: Boolean(projectId && revisionId), refetchInterval: 3_000 });
}

export function useWorkbenchPrototypeV2Shares(projectId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({ queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "shares"], queryFn: () => api.listShares(projectId), enabled: Boolean(projectId), refetchInterval: 3_000 });
}

export function useWorkbenchPrototypeV2Exports(projectId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({ queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "exports"], queryFn: () => api.listExports(projectId), enabled: Boolean(projectId), refetchInterval: 3_000 });
}

export function useReviseWorkbenchPrototypeV2Revision(projectId: string, revisionId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const client = useQueryClient();
  return usePrototypeMutation(`${projectId}:${revisionId}`, {
    mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request: RevisePrototypeRevisionRequest; idempotencyKey?: string }) => api.reviseRevision(projectId, revisionId, ifMatch, request, idempotencyKey),
    onSuccess: (result) => { client.setQueryData(workbenchQueryKeys.prototypeV2Plan(projectId, result.value.id), result); client.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); },
  });
}

export function useRetryWorkbenchPrototypeV2Plan(projectId: string, planId: string) {
  const api = useWorkbenchPrototypeV2Api();
  const client = useQueryClient();
  return usePrototypeMutation(`${projectId}:${planId}`, {
    mutationFn: ({ ifMatch, request, idempotencyKey }: { ifMatch: string; request?: PrototypeWorkflowActionRequest; idempotencyKey?: string }) => api.retryPlan(projectId, planId, ifMatch, request, idempotencyKey),
    onSuccess: (result) => { client.setQueryData(workbenchQueryKeys.prototypeV2Plan(projectId, result.value.id), result); client.invalidateQueries({ queryKey: workbenchQueryKeys.prototypeV2(projectId) }); },
  });
}

export function useWorkbenchPrototypeV2RevisionDiff(projectId: string, revisionId: string) {
  const api = useWorkbenchPrototypeV2Api();
  return useQuery({ queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "revision-diff", revisionId], queryFn: () => api.getRevisionDiff(projectId, revisionId), enabled: Boolean(projectId && revisionId) });
}

type PrototypeMutationVariables = { idempotencyKey?: string };
function usePrototypeMutation<TData, TVariables extends PrototypeMutationVariables>(
  scope: string,
  options: Omit<UseMutationOptions<TData, Error, TVariables>, "mutationFn"> & { mutationFn: (variables: TVariables) => Promise<TData> },
) {
  const pending = useRef(new Map<string, string>());
  return useMutation<TData, Error, TVariables>({
    ...options,
    mutationFn: async (variables) => {
      const signature = `${scope}:${JSON.stringify(variables)}`;
      const idempotencyKey = variables.idempotencyKey ?? pending.current.get(signature) ?? createIdempotencyKey("prototype-command");
      pending.current.set(signature, idempotencyKey);
      const result = await options.mutationFn({ ...variables, idempotencyKey });
      pending.current.delete(signature);
      return result;
    },
  });
}
