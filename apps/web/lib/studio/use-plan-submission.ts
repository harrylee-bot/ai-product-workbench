"use client";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CreatePrototypePlanRequest } from "@workbench/workbench-contracts";
import { useWorkbenchSubmissionIntentsApi } from "@/lib/studio/api";
import { useWorkbenchPrototypeV2Api } from "@/lib/studio/api";
import { useWorkbenchImportSourcesApi } from "@/lib/studio/api";
import {
  useWorkbenchFileTransferService,
  useWorkbenchUploadRegistry,
} from "@/lib/workbench/features/files";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import type { StudioSubmission, StudioPlanTarget } from "./types";
export function usePlanSubmission(projectId: string) {
  const api = useWorkbenchPrototypeV2Api(),
    sources = useWorkbenchImportSourcesApi(),
    client = useQueryClient();
  const intents = useWorkbenchSubmissionIntentsApi();
  const registry = useWorkbenchUploadRegistry(
    useWorkbenchFileTransferService(),
  );
  const busy = useRef(false),
    [pending, setPending] = useState(false);
  const prepared = useRef<{
    signature: string;
    request: CreatePrototypePlanRequest;
    key: string;
  } | null>(null);
  const fileSources = useRef(new WeakMap<File, Promise<string>>());
  const fileIdentity = useRef(new WeakMap<File, string>());
  const prepare = async (input: StudioSubmission, target: string) => {
    const signature = JSON.stringify({
      ...input,
      projectId,
      target,
      files: input.files.map((f) => {
        if (!fileIdentity.current.has(f))
          fileIdentity.current.set(f, crypto.randomUUID());
        return [f.name, f.size, f.lastModified, fileIdentity.current.get(f)];
      }),
    });
    if (prepared.current?.signature !== signature) {
      const ids: string[] = [];
      for (const file of input.files) {
        let result = fileSources.current.get(file);
        if (!result) {
          result = (async () => {
            const batch = await registry.uploadFiles(projectId, [{ file }]);
            const fileAssetId = batch.fileAssetIds[0];
            if (!fileAssetId) throw new Error("附件上传未完成，请重试");
            const source = await sources.createImportSource(
              projectId,
              { kind: "file", fileAssetId },
              `studio-source-${fileAssetId}`,
            );
            registry.completeUploadBatch(batch.batchId);
            return source.value.id;
          })();
          fileSources.current.set(file, result);
          result.catch(() => fileSources.current.delete(file));
        }
        const sourceId = await result;
        input.onFileSource?.(file, sourceId);
        ids.push(sourceId);
        await client.invalidateQueries({
          queryKey: workbenchQueryKeys.importSources(projectId),
        });
      }
      const sourceIds = [...new Set([...input.sourceIds, ...ids])];
      const resolved = await Promise.all(
        sourceIds
          .filter((id) => !input.pinnedSourceIds?.includes(id))
          .map((id) => sources.getImportSource(id)),
      );
      if (resolved.some((s) => s.value.status !== "ready"))
        throw new Error(
          "附件或引用资料还在解析。请在资料视图查看进度，待就绪后重试。",
        );
      prepared.current = {
        signature,
        key: createIdempotencyKey("studio-plan"),
        request: {
          title: input.prompt.trim().split("\n")[0]!.slice(0, 100),
          prompt: input.prompt.trim(),
          generationRequest: {
            prompt: input.prompt.trim(),
            modelId: input.modelId,
            workflow: input.workflow,
            targetSurface: input.targetSurface,
            designStyle: input.designStyle,
            sourceIds,
            requestedArtifactKinds: input.requestedArtifactKinds,
            artifactTargets: input.artifactTargets,
            generationIntent: input.generationIntent,
            ...(input.prdScreenPlan
              ? { prdScreenPlan: input.prdScreenPlan }
              : {}),
            canvasSnapshot: null,
          },
        },
      };
    }
    return prepared.current;
  };
  const create = async (input: StudioSubmission) => {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    try {
      const request = await prepare(input, "new");
      const result = await api.createPlan(
        projectId,
        request.request,
        request.key,
      );
      prepared.current = null;
      client.setQueryData(
        workbenchQueryKeys.prototypeV2Plan(projectId, result.value.id),
        result,
      );
      await client.invalidateQueries({
        queryKey: workbenchQueryKeys.prototypeV2(projectId),
      });
      return result.value;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const saveInput = async (
    input: StudioSubmission,
    target: StudioPlanTarget,
  ) => {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    try {
      const command = await prepare(input, JSON.stringify(target));
      const result =
        target.kind === "draft"
          ? await api.updatePlanInput(
              projectId,
              target.id,
              target.etag,
              command.request,
              command.key,
            )
          : await api.createRevisionPlan(
              projectId,
              target.id,
              target.etag,
              { ...command.request, feedbackIds: target.feedbackIds ?? [] },
              command.key,
            );
      prepared.current = null;
      client.setQueryData(
        workbenchQueryKeys.prototypeV2Plan(projectId, result.value.id),
        result,
      );
      await client.invalidateQueries({
        queryKey: workbenchQueryKeys.prototypeV2(projectId),
      });
      await client.invalidateQueries({
        queryKey: ["studio", "plan-input", projectId],
      });
      return result.value;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const submitRun = async (input: StudioSubmission, threadId: string) => {
    if (busy.current) return null;
    if (!threadId) throw new Error("项目尚未创建对话");
    busy.current = true;
    setPending(true);
    try {
      const command = await prepare(input, `thread:${threadId}`);
      const intent = await intents.createSubmissionIntent(
        threadId,
        { request: command.request.generationRequest!, attachments: [] },
        command.key,
      );
      const result = await intents.submitSubmissionIntent(intent.value.id);
      prepared.current = null;
      client.setQueryData(
        workbenchQueryKeys.run(result.value.run.id),
        result.value.run,
      );
      await client.invalidateQueries({
        queryKey: workbenchQueryKeys.bootstraps(projectId),
      });
      return result.value.run.id;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { create, saveInput, submitRun, pending, uploads: registry.uploads };
}
