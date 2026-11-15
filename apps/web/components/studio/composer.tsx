"use client";
import { useState, useRef, useEffect, type ReactNode } from "react";
import type { ComposerDraft } from "@/lib/studio/composer-session";
import type {
  ProjectBootstrap,
  StartRunRequest,
  PrototypeInputSnapshot,
  RunDesignStyle,
  RunTargetSurface,
} from "@workbench/workbench-contracts";
import { useWorkbenchRuntimeModels } from "@/lib/workbench/features/runtime-models";
import { useWorkbenchDesignPresets } from "@/lib/workbench/features/design-presets";
import { useWorkbenchImportSources } from "@/lib/workbench/features/import-sources";
import type { WorkbenchUploadItemViewModel } from "@/lib/workbench/files/upload-registry";
import type {
  StudioSubmission,
  StudioArtifactContext,
} from "@/lib/studio/types";
import { ChatInput } from "./onlook/chat-input";
export type StudioComposerProps = {
  projectId: string;
  bootstrap: ProjectBootstrap;
  prompt: string;
  setPrompt: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  uploads?: WorkbenchUploadItemViewModel[];
  draft: ComposerDraft;
  updateDraft: (transform: (draft: ComposerDraft) => ComposerDraft) => void;
  locked?: boolean;
  outputLocked?: boolean;
  initialInput?: StartRunRequest;
  pinnedSources?: PrototypeInputSnapshot["sources"];
  pinnedDesign?: PrototypeInputSnapshot["designStyle"];
  intentControl?: ReactNode;
  artifactContext?: StudioArtifactContext;
  onSubmit: (value: StudioSubmission) => Promise<string | null>;
};
export function StudioComposer({
  projectId,
  bootstrap,
  prompt,
  setPrompt,
  busy,
  disabled,
  uploads = [],
  draft,
  updateDraft,
  locked = false,
  outputLocked = false,
  initialInput,
  pinnedSources = [],
  pinnedDesign,
  intentControl,
  artifactContext,
  onSubmit,
}: StudioComposerProps) {
  const models = useWorkbenchRuntimeModels(),
    presets = useWorkbenchDesignPresets(),
    sources = useWorkbenchImportSources(projectId);
  const {
    files,
    sourceIds,
    modelId: model,
    targetSurface: surface,
    designStyle: designReference,
  } = draft;
  const output =
    draft.requestedArtifactKinds.length > 1
      ? "both"
      : (draft.requestedArtifactKinds[0] ?? "prototype");
  const design =
    designReference.kind === "preset"
      ? presetValue(designReference)
      : designReference.kind === "artifact"
        ? `artifact:${designReference.artifactVersionId}`
        : "automatic";
  const setFiles = (transform: (files: File[]) => File[]) =>
    updateDraft((current) => ({ ...current, files: transform(current.files) }));
  const setSourceIds = (transform: (ids: string[]) => string[]) =>
    updateDraft((current) => ({
      ...current,
      sourceIds: transform(current.sourceIds),
    }));
  const [error, setError] = useState(""),
    [contextOpen, setContextOpen] = useState(false);
  const sourceLabels = useRef(new Map<string, string>());
  for (const source of sources.data?.items ?? [])
    sourceLabels.current.set(source.id, source.label);
  for (const source of pinnedSources)
    sourceLabels.current.set(source.sourceId, source.label);
  const available =
    models.data?.items.filter((m) =>
      m.supportedWorkflows.includes(
        artifactContext?.workflow ?? initialInput?.workflow ?? "generate",
      ),
    ) ?? [];
  useEffect(() => {
    if (!model && available[0])
      updateDraft((current) =>
        current.modelId ? current : { ...current, modelId: available[0]!.id },
      );
  }, [model, available, updateDraft]);
  const designArtifacts = bootstrap.artifacts.filter(
    (artifact) =>
      artifact.kind === "design_system" &&
      artifact.currentVersion?.status === "ready",
  );
  const modelId = model
    ? (available.find((m) => m.id === model)?.id ?? "")
    : (available[0]?.id ?? "");
  const addFiles = (incoming: File[]) => {
    if (locked) {
      setError("修改版本沿用源资料。选择“新建计划”后可添加附件。");
      return;
    }
    setFiles((current) =>
      [...current, ...incoming].filter(
        (file, index, all) =>
          all.findIndex(
            (f) =>
              f.name === file.name &&
              f.size === file.size &&
              f.lastModified === file.lastModified,
          ) === index,
      ),
    );
    updateDraft((current) => ({
      ...current,
      missingFiles: current.missingFiles.filter(
        (item) =>
          !incoming.some(
            (file) =>
              file.name === item.name &&
              file.size === item.size &&
              file.type === item.type,
          ),
      ),
    }));
  };
  const screenshot = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error("此浏览器不支持截屏，请添加截图文件");
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      try {
        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (blob)
          addFiles([new File([blob], "屏幕截图.png", { type: "image/png" })]);
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "截屏失败");
    }
  };
  const send = async () => {
    setError("");
    try {
      if (!designAvailable)
        throw new Error("所选设计已失效，请重新选择固定版本");
      const designStyle = designReference;
      const text = prompt;
      await onSubmit({
        prompt: text,
        modelId,
        workflow:
          artifactContext?.workflow ?? initialInput?.workflow ?? "generate",
        requestedArtifactKinds:
          artifactContext?.requestedArtifactKinds ??
          (output === "both"
            ? ["prd", "prototype"]
            : output === "prd"
              ? ["prd"]
              : ["prototype"]),
        targetSurface: surface,
        designStyle,
        sourceIds: locked ? [] : sourceIds,
        pinnedSourceIds: pinnedSources.map((source) => source.sourceId),
        files: locked ? [] : files,
        artifactTargets:
          artifactContext?.artifactTargets ??
          initialInput?.artifactTargets ??
          [],
        generationIntent:
          artifactContext?.generationIntent ??
          initialInput?.generationIntent ??
          null,
        prdScreenPlan:
          artifactContext?.prdScreenPlan ?? initialInput?.prdScreenPlan,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请重试");
    }
  };
  const invalidSources = sourceIds.filter(
    (id) =>
      !pinnedSources.some((source) => source.sourceId === id) &&
      (sources.isError ||
        !sources.data?.items.some(
          (item) => item.id === id && item.status === "ready",
        )),
  );
  const readySources = invalidSources.length === 0;
  const designAvailable =
    design === "automatic" ||
    (design.startsWith("artifact:") &&
      designArtifacts.some(
        (a) =>
          a.kind === "design_system" &&
          a.currentVersion?.status === "ready" &&
          a.currentVersion.artifactVersionId === design.slice(9),
      )) ||
    presets.data?.items.some(
      (p) =>
        designReference.kind === "preset" &&
        p.presetId === designReference.presetId &&
        p.version === designReference.version &&
        p.checksum === designReference.checksum,
    ) ||
    Boolean(
      pinnedDesign?.snapshot &&
        initialInput &&
        JSON.stringify(initialInput.designStyle) ===
          JSON.stringify(designReference),
    );
  return (
    <ChatInput
      value={prompt}
      onChange={setPrompt}
      onSendMessage={send}
      onFiles={addFiles}
      onScreenshot={screenshot}
      isStreaming={busy}
      disabled={
        disabled ||
        !modelId ||
        !readySources ||
        !designAvailable ||
        draft.missingFiles.length > 0
      }
      context={
        <>
          {intentControl}
          {artifactContext && <p>基于固定产物：{artifactContext.title}</p>}
        </>
      }
      error={
        error ||
        (draft.missingFiles.length
          ? "附件内容尚未恢复，请重新选择本机文件或移除后再提交"
          : !designAvailable
            ? "所选设计不可用，请重载或明确选择其他设计"
            : !readySources
              ? "引用资料尚未就绪、已删除或无权限。请移除失效引用或重新加载资料。"
              : !models.isPending && !modelId
                ? model && available.length
                  ? "所选模型不支持当前操作，请选择可用模型"
                  : "没有可用模型，请重试加载"
                : "")
      }
      attachments={
        <>
          {draft.missingFiles.length > 0 && (
            <div className="studio-chips" aria-label="待恢复附件">
              {draft.missingFiles.map((file, index) => (
                <span key={`${file.name}-${index}`}>
                  {file.name} · 需重新选择本机文件
                  <button
                    type="button"
                    aria-label={`移除待恢复附件 ${file.name}`}
                    onClick={() =>
                      updateDraft((current) => ({
                        ...current,
                        missingFiles: current.missingFiles.filter(
                          (_, position) => position !== index,
                        ),
                      }))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {sourceIds.length > 0 && (
            <div className="studio-chips" aria-label="已引用资料">
              {sourceIds.map((id) => (
                <span key={id}>
                  {sourceLabels.current.get(id) ?? id}
                  {invalidSources.includes(id) ? " · 不可用" : ""}
                  <button
                    type="button"
                    aria-label={`移除引用 ${sourceLabels.current.get(id) ?? id}`}
                    onClick={() =>
                      setSourceIds((current) =>
                        current.filter((value) => value !== id),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="studio-chips">
              {files.map((file, i) => (
                <span key={`${file.name}-${i}`}>
                  {file.name} ·{" "}
                  {uploads.find(
                    (item) =>
                      item.fileName === file.name &&
                      item.byteSize === file.size,
                  )?.statusLabel ?? "待上传"}
                  <button
                    aria-label={`移除 ${file.name}`}
                    onClick={() =>
                      setFiles((current) => current.filter((f) => f !== file))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {contextOpen && (
            <div className="studio-composer-options">
              <h3>引用资料</h3>
              {sources.data?.items.length === 0 && (
                <p>在资料视图导入网站、GitHub、Figma 或文件。</p>
              )}
              {sources.data?.items.map((source) => (
                <label key={source.id}>
                  <input
                    type="checkbox"
                    checked={sourceIds.includes(source.id)}
                    disabled={
                      locked ||
                      ((sources.isError || source.status !== "ready") &&
                        !sourceIds.includes(source.id))
                    }
                    onChange={(e) =>
                      setSourceIds((current) =>
                        e.target.checked
                          ? [...current, source.id]
                          : current.filter((id) => id !== source.id),
                      )
                    }
                  />
                  {source.label || source.id} · {source.status}
                </label>
              ))}
              {sources.error && (
                <button onClick={() => void sources.refetch()}>
                  重新加载资料
                </button>
              )}
            </div>
          )}
        </>
      }
      controls={
        <>
          <select
            aria-label="模型"
            value={modelId}
            onChange={(e) =>
              updateDraft((current) => ({
                ...current,
                modelId: e.target.value,
              }))
            }
            disabled={locked}
          >
            {model && !available.some((m) => m.id === model) && (
              <option value="">所选模型不可用</option>
            )}
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          {models.error && (
            <button onClick={() => void models.refetch()}>重载模型</button>
          )}
          <select
            aria-label="输出类型"
            value={
              artifactContext
                ? artifactContext.requestedArtifactKinds.join("+")
                : output
            }
            onChange={(e) =>
              updateDraft((current) => ({
                ...current,
                requestedArtifactKinds:
                  e.target.value === "both"
                    ? ["prd", "prototype"]
                    : e.target.value === "prd"
                      ? ["prd"]
                      : ["prototype"],
              }))
            }
            disabled={locked || outputLocked || !!artifactContext}
          >
            {artifactContext &&
              !["prd", "prototype"].includes(
                artifactContext.requestedArtifactKinds.join("+"),
              ) && (
                <option
                  value={artifactContext.requestedArtifactKinds.join("+")}
                >
                  当前产物
                </option>
              )}
            <option value="both">文档＋原型</option>
            <option value="prd">需求文档</option>
            <option value="prototype">交互原型</option>
          </select>
          <select
            aria-label="目标终端"
            value={surface}
            onChange={(e) =>
              updateDraft((current) => ({
                ...current,
                targetSurface: e.target.value as RunTargetSurface,
              }))
            }
            disabled={locked}
          >
            <option value="web">Web</option>
            <option value="app">App</option>
          </select>
          <select
            aria-label="设计风格"
            value={design}
            onChange={(e) => {
              const value = e.target.value;
              const preset = presets.data?.items.find(
                (p) => presetValue(p) === value,
              );
              const designStyle: RunDesignStyle =
                value === "automatic"
                  ? { kind: "automatic" }
                  : value.startsWith("artifact:")
                    ? { kind: "artifact", artifactVersionId: value.slice(9) }
                    : preset
                      ? {
                          kind: "preset",
                          presetId: preset.presetId,
                          version: preset.version,
                          checksum: preset.checksum,
                        }
                      : designReference;
              updateDraft((current) => ({ ...current, designStyle }));
            }}
            disabled={locked}
          >
            <option value="automatic">自动设计</option>
            {design !== "automatic" &&
              !presets.data?.items.some((p) => presetValue(p) === design) &&
              !designArtifacts.some(
                (a) =>
                  `artifact:${a.currentVersion?.artifactVersionId}` === design,
              ) && (
                <option value={design}>
                  {designAvailable ? "沿用固定设计快照" : "所选设计不可用"}
                </option>
              )}
            {presets.data?.items.map((p) => (
              <option key={p.presetId} value={presetValue(p)}>
                {p.label} · {p.version}
              </option>
            ))}
            {designArtifacts.map((a) => (
              <option
                key={a.id}
                value={`artifact:${a.currentVersion!.artifactVersionId}`}
              >
                {a.title}
              </option>
            ))}
          </select>
          {presets.error && (
            <button onClick={() => void presets.refetch()}>重载设计</button>
          )}
          <button
            type="button"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((value) => !value)}
          >
            资料{sourceIds.length ? ` ${sourceIds.length}` : ""}
          </button>
        </>
      }
    />
  );
}

function presetValue(value: {
  presetId: string;
  version: number;
  checksum: string;
}) {
  return `preset:${value.presetId}:${value.version}:${value.checksum}`;
}
