"use client";
import { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { requirementDiscussionRequestSchema } from "@workbench/workbench-contracts";
import { useWorkbenchImportSourcesApi } from "./api";
import {
  useWorkbenchFileTransferService,
  useWorkbenchUploadRegistry,
} from "@/lib/workbench/features/files";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import type { StudioSubmission } from "./types";

/** Existing authorized file/source services, shared by discussion input.
 * Resolves files to durable source IDs before persisting a replayable command. */
export function useStudioInputPreparation(projectId: string) {
  const sources = useWorkbenchImportSourcesApi();
  const client = useQueryClient();
  const registry = useWorkbenchUploadRegistry(
    useWorkbenchFileTransferService(),
  );
  const active = useRef<{ cancelled: boolean } | null>(null);
  const fileSources = useRef({
    projectId,
    files: new WeakMap<File, Promise<string>>(),
  });
  if (fileSources.current.projectId !== projectId)
    fileSources.current = { projectId, files: new WeakMap() };
  const prepare = async (input: StudioSubmission, assertScope: () => void) => {
    const attempt = { cancelled: false };
    active.current = attempt;
    const checkActive = () => {
      assertScope();
      if (attempt.cancelled) throw new Error("附件上传已取消，本次需求未发送。输入已保留，请核对附件后重新发送。");
    };
    checkActive();
    const ids: string[] = [];
    for (const file of input.files) {
      const cache = fileSources.current.files;
      let result = cache.get(file);
      if (!result) {
        result = (async () => {
          const batch = await registry.uploadFiles(projectId, [{ file }]);
          if (attempt.cancelled || !batch.fileAssetIds[0]) registry.completeUploadBatch(batch.batchId);
          checkActive();
          const fileAssetId = batch.fileAssetIds[0];
          if (!fileAssetId) throw new Error("附件上传已取消，本次需求未发送。输入已保留。");
          const source = await sources.createImportSource(
            projectId,
            { kind: "file", fileAssetId },
            `studio-source-${fileAssetId}`,
          );
          checkActive();
          registry.completeUploadBatch(batch.batchId);
          return source.value.id;
        })();
        cache.set(file, result);
        result.catch(() => cache.delete(file));
      }
      const id = await result;
      checkActive();
      input.onFileSource?.(file, id);
      ids.push(id);
      await client.invalidateQueries({
        queryKey: workbenchQueryKeys.importSources(projectId),
      });
    }
    const sourceIds = [...new Set([...input.sourceIds, ...ids])].sort();
    const resolved = await Promise.all(
      sourceIds
        .filter((id) => !input.pinnedSourceIds?.includes(id))
        .map((id) => sources.getImportSource(id)),
    );
    checkActive();
    if (
      resolved.some(
        (source) =>
          source.value.projectId !== projectId ||
          source.value.status !== "ready",
      )
    )
      throw new Error(
        "引用资料尚未就绪、已删除或无权限。请保留输入，核对资料后重试。",
      );
    return requirementDiscussionRequestSchema.parse({
      prompt: input.prompt.trim(),
      modelId: input.modelId,
      workflow: input.workflow,
      targetSurface: input.targetSurface,
      designStyle: input.designStyle,
      sourceIds,
      requestedArtifactKinds: input.requestedArtifactKinds,
      artifactTargets: input.artifactTargets,
      generationIntent: input.generationIntent,
      ...(input.prdScreenPlan ? { prdScreenPlan: input.prdScreenPlan } : {}),
      canvasSnapshot: null,
    });
  };
  return {
    prepare,
    uploads: registry.uploads,
    retryUpload: registry.retryUpload,
    cancelUpload: async (id: string) => {
      if (active.current) active.current.cancelled = true;
      await registry.cancelUpload(id);
    },
  };
}
