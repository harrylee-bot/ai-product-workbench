"use client";
import { useState, useRef, type ReactNode } from "react";
import type {
  ProjectBootstrap,
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
  locked?: boolean;
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
  locked = false,
  intentControl,
  artifactContext,
  onSubmit,
}: StudioComposerProps) {
  const models = useWorkbenchRuntimeModels(),
    presets = useWorkbenchDesignPresets(),
    sources = useWorkbenchImportSources(projectId);
  const [files, setFiles] = useState<File[]>([]),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    [model, setModel] = useState(""),
    [output, setOutput] = useState("both"),
    [surface, setSurface] = useState<RunTargetSurface>("web"),
    [design, setDesign] = useState("automatic"),
    [error, setError] = useState(""),
    [contextOpen, setContextOpen] = useState(false);
  const sourceLabels = useRef(new Map<string, string>());
  for (const source of sources.data?.items ?? [])
    sourceLabels.current.set(source.id, source.label);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const available =
    models.data?.items.filter((m) =>
      m.supportedWorkflows.includes(artifactContext?.workflow ?? "generate"),
    ) ?? [];
  const modelId =
    available.find((m) => m.id === model)?.id ?? available[0]?.id ?? "";
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
      const preset = presets.data?.items.find((p) => p.presetId === design);
      const designStyle: RunDesignStyle = design.startsWith("artifact:")
        ? { kind: "artifact", artifactVersionId: design.slice(9) }
        : preset
          ? {
              kind: "preset",
              presetId: preset.presetId,
              version: preset.version,
              checksum: preset.checksum,
            }
          : { kind: "automatic" };
      const text = prompt;
      const submittedFiles = files;
      const accepted = await onSubmit({
        prompt: text,
        modelId,
        workflow: artifactContext?.workflow ?? "generate",
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
        files: locked ? [] : files,
        artifactTargets: artifactContext?.artifactTargets ?? [],
        generationIntent: null,
      });
      if (accepted) {
        if (promptRef.current === text) setPrompt("");
        setFiles((current) =>
          current.filter((f) => !submittedFiles.includes(f)),
        );
        setSourceIds([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请重试");
    }
  };
  const invalidSources = sourceIds.filter(
    (id) =>
      sources.isError ||
      !sources.data?.items.some(
        (item) => item.id === id && item.status === "ready",
      ),
  );
  const readySources = invalidSources.length === 0;
  return (
    <ChatInput
      value={prompt}
      onChange={setPrompt}
      onSendMessage={send}
      onFiles={addFiles}
      onScreenshot={screenshot}
      isStreaming={busy}
      disabled={disabled || !modelId || !readySources}
      context={
        <>
          {intentControl}
          {artifactContext && <p>基于固定产物：{artifactContext.title}</p>}
        </>
      }
      error={
        error ||
        (!readySources
          ? "引用资料尚未就绪、已删除或无权限。请移除失效引用或重新加载资料。"
          : !models.isPending && !modelId
            ? "没有可用模型，请重试加载"
            : "")
      }
      attachments={
        <>
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
            onChange={(e) => setModel(e.target.value)}
            disabled={locked}
          >
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
            onChange={(e) => setOutput(e.target.value)}
            disabled={locked || !!artifactContext}
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
            onChange={(e) => setSurface(e.target.value as RunTargetSurface)}
            disabled={locked}
          >
            <option value="web">Web</option>
            <option value="app">App</option>
          </select>
          <select
            aria-label="设计风格"
            value={design}
            onChange={(e) => setDesign(e.target.value)}
            disabled={locked}
          >
            <option value="automatic">自动设计</option>
            {presets.data?.items.map((p) => (
              <option key={p.presetId} value={p.presetId}>
                {p.label}
              </option>
            ))}
            {bootstrap.artifacts
              .filter((a) => a.kind === "design_system" && a.currentVersion)
              .map((a) => (
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
