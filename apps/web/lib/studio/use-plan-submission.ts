"use client";
import { useRef, useState } from "react";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  canonicalJson,
  createPrototypePlanRequestSchema,
} from "@workbench/workbench-contracts";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  useWorkbenchSubmissionIntentsApi,
  useWorkbenchPrototypeV2Api,
  useWorkbenchImportSourcesApi,
} from "@/lib/studio/api";
import {
  useWorkbenchFileTransferService,
  useWorkbenchUploadRegistry,
} from "@/lib/workbench/features/files";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import { studioRecordKey, useStudioStoredRecord } from "./stored-record";
import type { StudioSubmission, StudioPlanTarget } from "./types";

const submissionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ kind: z.literal("thread"), id: z.string() }).strict(),
  z
    .object({ kind: z.literal("draft"), id: z.string(), etag: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal("revision"),
      id: z.string(),
      etag: z.string(),
      feedbackIds: z.array(z.string()),
    })
    .strict(),
]);
const submissionRecordSchema = z
  .object({
    version: z.literal(1),
    signature: z.string(),
    key: z.string(),
    request: createPrototypePlanRequestSchema,
    target: submissionTargetSchema,
  })
  .strict();
type SubmissionTarget = z.infer<typeof submissionTargetSchema>;
class InactiveSubmission extends Error {}

export function usePlanSubmission(projectId: string) {
  const api = useWorkbenchPrototypeV2Api(),
    sources = useWorkbenchImportSourcesApi(),
    client = useQueryClient();
  const intents = useWorkbenchSubmissionIntentsApi();
  const registry = useWorkbenchUploadRegistry(
    useWorkbenchFileTransferService(),
  );
  const { user } = useWorkbenchAuth();
  const local = useStudioStoredRecord(
    studioRecordKey(user?.id, projectId, "submission"),
    submissionRecordSchema,
  );
  const busy = useRef<{ isCurrent: () => boolean } | null>(null),
    [pendingScope, setPendingScope] = useState<{
      isCurrent: () => boolean;
    } | null>(null);
  const pending = !!pendingScope?.isCurrent();
  const fileSources = useRef(new WeakMap<File, Promise<string>>());
  const checkActive = () => {
    if (!local.isCurrent()) throw new InactiveSubmission();
  };
  const prepare = async (input: StudioSubmission, target: SubmissionTarget) => {
    checkActive();
    const ids: string[] = [];
    for (const file of input.files) {
      let result = fileSources.current.get(file);
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
        fileSources.current.set(file, result);
        result.catch(() => fileSources.current.delete(file));
      }
      const sourceId = await result;
      checkActive();
      input.onFileSource?.(file, sourceId);
      ids.push(sourceId);
      await client.invalidateQueries({
        queryKey: workbenchQueryKeys.importSources(projectId),
      });
      checkActive();
    }
    const sourceIds = [...new Set([...input.sourceIds, ...ids])].sort();
    const request = createPrototypePlanRequestSchema.parse({
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
        ...(input.prdScreenPlan ? { prdScreenPlan: input.prdScreenPlan } : {}),
        canvasSnapshot: null,
      },
    });
    // An accepted write may advance the ETag. Recover the original command before
    // checking mutable source status or replacing its compare-and-swap token.
    const { etag: _etag, ...identity } = {
      ...target,
      etag: "etag" in target ? target.etag : undefined,
    };
    const signature = canonicalJson({ projectId, target: identity, request });
    if (local.value?.signature === signature) return local.value;
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
        "附件或引用资料还在解析。请在资料视图查看进度，待就绪后重试。",
      );
    const command = {
      version: 1 as const,
      signature,
      key: createIdempotencyKey("studio-plan"),
      request,
      target,
    };
    local.save(command);
    return command;
  };
  const execute = async (command: z.infer<typeof submissionRecordSchema>) => {
    checkActive();
    const target = command.target;
    if (target.kind === "thread") {
      const intent = await intents.createSubmissionIntent(
        target.id,
        { request: command.request.generationRequest, attachments: [] },
        command.key,
      );
      checkActive();
      const result = await intents.submitSubmissionIntent(intent.value.id);
      checkActive();
      local.clear();
      client.setQueryData(
        workbenchQueryKeys.run(result.value.run.id),
        result.value.run,
      );
      void client.invalidateQueries({
        queryKey: workbenchQueryKeys.bootstraps(projectId),
      });
      return result.value.run.id;
    }
    const result =
      target.kind === "new"
        ? await api.createPlan(projectId, command.request, command.key)
        : target.kind === "draft"
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
              { ...command.request, feedbackIds: target.feedbackIds },
              command.key,
            );
    checkActive();
    local.clear();
    client.setQueryData(
      workbenchQueryKeys.prototypeV2Plan(projectId, result.value.id),
      result,
    );
    void Promise.all([
      client.invalidateQueries({
        queryKey: workbenchQueryKeys.prototypeV2(projectId),
      }),
      client.invalidateQueries({
        queryKey: ["studio", "plan-input", projectId],
      }),
    ]);
    return result.value;
  };
  const submit = async (input: StudioSubmission, target: SubmissionTarget) => {
    if (busy.current?.isCurrent()) return null;
    const operation = { isCurrent: local.isCurrent };
    busy.current = operation;
    setPendingScope(operation);
    try {
      return await execute(await prepare(input, target));
    } catch (cause) {
      if (cause instanceof InactiveSubmission) return null;
      // A received CAS rejection is definitive. An explicit rebase must get a
      // fresh command; uncertain network/5xx outcomes keep the original one.
      if (isWorkbenchApiError(cause) && cause.status === 412) local.clear();
      throw cause;
    } finally {
      if (busy.current === operation) busy.current = null;
      setPendingScope((current) => (current === operation ? null : current));
    }
  };
  const recover = async () => {
    if (!local.value || busy.current?.isCurrent()) return null;
    const operation = { isCurrent: local.isCurrent };
    busy.current = operation;
    setPendingScope(operation);
    try {
      return await execute(local.value);
    } catch (cause) {
      if (cause instanceof InactiveSubmission) return null;
      // A received CAS rejection is definitive. An explicit rebase must get a
      // fresh command; uncertain network/5xx outcomes keep the original one.
      if (isWorkbenchApiError(cause) && cause.status === 412) local.clear();
      throw cause;
    } finally {
      if (busy.current === operation) busy.current = null;
      setPendingScope((current) => (current === operation ? null : current));
    }
  };
  const create = async (input: StudioSubmission) => {
    const result = await submit(input, { kind: "new" });
    return typeof result === "string" ? null : result;
  };
  const saveInput = async (
    input: StudioSubmission,
    target: StudioPlanTarget,
  ) => {
    const normalized =
      target.kind === "revision"
        ? {
            ...target,
            feedbackIds: [...new Set(target.feedbackIds ?? [])].sort(),
          }
        : { kind: target.kind, id: target.id, etag: target.etag };
    const result = await submit(input, normalized);
    return typeof result === "string" ? null : result;
  };
  const submitRun = async (input: StudioSubmission, threadId: string) => {
    if (!threadId) throw new Error("项目尚未创建对话");
    const result = await submit(input, { kind: "thread", id: threadId });
    return typeof result === "string" ? result : null;
  };
  return {
    create,
    saveInput,
    submitRun,
    pending,
    uploads: registry.uploads,
    recover,
    recoveryTitle: local.value?.request.title,
    recoveryNotice:
      local.error ||
      (local.value
        ? "已保留上次提交记录。使用相同输入重试会确认同一次提交；修改输入后再提交会发起新操作。"
        : ""),
  };
}
