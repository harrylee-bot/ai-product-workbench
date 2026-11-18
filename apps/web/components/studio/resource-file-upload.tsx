"use client";

import { useRef, useState } from "react";
import type { ImportSource } from "@workbench/workbench-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkbenchImportSourcesApi } from "@/lib/studio/api";
import { useWorkbenchFileTransferService, useWorkbenchUploadRegistry } from "@/lib/workbench/features/files";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { useStudioAction } from "./actions";

export function ResourceFileUpload({ projectId, sources }: { projectId: string; sources: ImportSource[] }) {
  const registry = useWorkbenchUploadRegistry(useWorkbenchFileTransferService());
  const api = useWorkbenchImportSourcesApi(), client = useQueryClient();
  const action = useStudioAction(), transferAction = useStudioAction();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<ImportSource | null>(null);
  const receipt = useRef<{ fileAssetId: string; key: string } | null>(null);
  const stale = target && !sources.some(s => s.id === target.id && s.revision === target.revision);

  function resetTransfer() {
    receipt.current = null;
    registry.releaseProjectUploads(projectId);
  }
  async function submit() {
    if (!file || stale) return;
    if (!receipt.current) {
      registry.releaseProjectUploads(projectId);
      const batch = await registry.uploadFiles(projectId, [{ file }]);
      const fileAssetId = batch.fileAssetIds[0];
      registry.completeUploadBatch(batch.batchId);
      if (!fileAssetId) throw new Error("上传已取消。");
      receipt.current = { fileAssetId, key: crypto.randomUUID() };
    }
    const source = await api.createImportSource(projectId, {
      kind: "file", fileAssetId: receipt.current.fileAssetId,
      ...(target && { replaces: { sourceId: target.id, revision: target.revision } }),
    }, receipt.current.key);
    if (source.value.status !== "ready") throw new Error("资料已失效，请重新选择文件。");
    receipt.current = null;
    setFile(null);
    setTarget(null);
    if (input.current) input.current.value = "";
    await client.invalidateQueries({ queryKey: workbenchQueryKeys.importSources(projectId) });
  }
  return (
    <section aria-label="项目文件">
      <form className="studio-inline-form" onSubmit={e => {
        e.preventDefault();
        void action.run(submit, target ? "项目文件已替换" : "项目文件已添加");
      }}>
        <select aria-label="文件操作" value={target?.id ?? ""} disabled={action.busy}
          onChange={e => {
            resetTransfer();
            setTarget(sources.find(s => s.id === e.target.value) ?? null);
          }}>
          <option value="">添加项目文件</option>
          {stale && <option value={target.id} disabled>资料已变更，请重新选择</option>}
          {sources.filter(s => s.kind === "file" && s.status === "ready" && !(stale && s.id === target.id)).map(s =>
            <option value={s.id} key={s.id}>替换 {s.label}</option>)}
        </select>
        <input ref={input} type="file" aria-label="项目资料文件" disabled={action.busy}
          onChange={e => { resetTransfer(); setFile(e.target.files?.[0] ?? null); }} />
        <button disabled={!file || action.busy || !!stale}>{target ? "上传并替换" : "上传文件"}</button>
      </form>
      {registry.uploads.map(item => (
        <div key={item.id}>
          <span role="status">{item.fileName} · {item.statusLabel} · {item.progress}%</span>
          {item.error && <span role="alert">{item.error.message}</span>}
          {item.canRetry && <button disabled={transferAction.busy} onClick={() => void transferAction.run(() => registry.retryUpload(item.id), "已重试")}>重试处理</button>}
          {item.canCancel && <button disabled={transferAction.busy} onClick={() => void transferAction.run(() => registry.cancelUpload(item.id), "已取消")}>取消上传</button>}
        </div>
      ))}
      {transferAction.notice}
      {action.notice}
    </section>
  );
}
