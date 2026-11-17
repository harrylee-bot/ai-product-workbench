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
  const fileSources = useRef({
    projectId,
    files: new WeakMap<File, Promise<string>>(),
  });
  if (fileSources.current.projectId !== projectId)
    fileSources.current = { projectId, files: new WeakMap() };
  const prepare = async (input: StudioSubmission, checkActive: () => void) => {
    checkActive();
    const ids: string[] = [];
    for (const file of input.files) {
      const cache = fileSources.current.files;
      let result = cache.get(file);
      if (!result) {
        result = (async () => {
          const batch = await registry.uploadFiles(projectId, [{ file }]);
          checkActive();
          const fileAssetId = batch.fileAssetIds[0];
          if (!fileAssetId) throw new Error("附件上传未完成，请重试");
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
      canvasSnapshot: input.canvasSnapshot ?? null,
    });
  };
  return { prepare, uploads: registry.uploads };
}
