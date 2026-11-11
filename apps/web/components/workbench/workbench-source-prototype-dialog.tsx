"use client";

import { sourcePrototypeInputSchema, type ArtifactCreation, type SourcePrototypeDocument, type SourcePrototypeInput } from "@workbench/workbench-contracts";
import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

import { useCreateWorkbenchArtifact } from "../../lib/workbench/features/artifacts";
import { useWorkbenchProjectSession } from "../../lib/workbench/project-session";

export function sourcePrototypeSample(documentId = "source-prototype-sample"): SourcePrototypeInput {
  return {
    protocol: "workbench.prototype-source-input.v1", documentId,
    title: "采购申请", revision: 1,
    summary: "填写采购事项和金额，提交后展示确认结果。",
    entryFile: "src/App.tsx",
    files: [
      { path: "src/App.tsx", content: `import React, { useState } from 'react';\nimport './style.css';\n\nexport default function App() {\n  const [submitted, setSubmitted] = useState(false);\n  return <main className="page">\n    <h1>采购申请</h1>\n    {submitted ? <section role="status"><h2>申请已提交</h2><p>采购审批将由负责人处理。</p><button onClick={() => setSubmitted(false)}>继续申请</button></section> :\n      <form onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }}>\n        <label>采购事项<input name="subject" required placeholder="请输入采购事项" /></label>\n        <label>预算金额<input name="amount" type="number" min="1" required placeholder="请输入预算金额" /></label>\n        <button type="submit">提交申请</button>\n      </form>}\n  </main>;\n}\n` },
      { path: "src/style.css", content: `*{box-sizing:border-box}body{margin:0;background:#f3f4f8;color:#202124;font-family:system-ui,sans-serif}.page{width:min(100%,480px);margin:32px auto;padding:28px;background:white;border-radius:18px}h1{margin:0 0 24px;font-size:24px}form,label{display:grid;gap:10px}form{gap:20px}input,button{font:inherit;min-height:44px;border-radius:8px;padding:10px 12px}input{width:100%;border:1px solid #d9dce5}button{border:0;background:#7559ec;color:white;cursor:pointer}@media(max-width:500px){.page{margin:0;border-radius:0;min-height:100vh}}` },
    ],
    pages: [{ id: "purchase-request", name: "采购申请", route: "/" }],
  };
}

function editableSourceDocument(document: SourcePrototypeDocument): SourcePrototypeInput {
  const { assets: _assets, build: _build, ...source } = document;
  return sourcePrototypeInputSchema.parse({ ...source, protocol: "workbench.prototype-source-input.v1", revision: document.revision + 1 });
}

export function WorkbenchSourcePrototypeDialog({
  document, onCommit, onCreated, onOpenChange, open, projectId,
}: {
  document?: SourcePrototypeDocument;
  onCommit?: (document: SourcePrototypeInput) => Promise<void>;
  onCreated?: (creation: ArtifactCreation) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const session = useWorkbenchProjectSession(projectId);
  const creation = useCreateWorkbenchArtifact(projectId);
  const [draft, setDraft] = useState<SourcePrototypeInput>(() => document
    ? editableSourceDocument(document) : sourcePrototypeSample(`source-${crypto.randomUUID()}`));
  const [selectedFile, setSelectedFile] = useState(draft.entryFile);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const operationRef = useRef(0);
  const requestRef = useRef<{ body: string; key: string } | null>(null);
  const busy = saving || reading || creation.isPending;
  const selected = draft.files.find((file) => file.path === selectedFile) ?? draft.files[0]!;
  const update = (change: Partial<SourcePrototypeInput>) => {
    setDraft((current) => ({ ...current, ...change }));
    setError(null);
  };
  const importProject = async (file: File | undefined) => {
    if (!file) return;
    const operation = ++operationRef.current;
    setError(null);
    if (file.size === 0 || file.size > 2 * 1024 ** 2) {
      setError("请选择 2 MB 以内的源码工程 JSON 文件");
      return;
    }
    setReading(true);
    try {
      const value = sourcePrototypeInputSchema.parse(JSON.parse(await file.text()));
      if (!session.isCurrent() || operation !== operationRef.current) return;
      if (document && value.documentId !== document.documentId) throw new Error("修订工程必须保留原型标识");
      const next = document ? { ...value, revision: document.revision + 1 } : value;
      setDraft(next);
      setSelectedFile(next.entryFile);
    } catch {
      if (session.isCurrent() && operation === operationRef.current) setError("文件不是受支持的源码原型工程，请检查入口文件、页面和源码内容");
    } finally {
      if (session.isCurrent() && operation === operationRef.current) setReading(false);
    }
  };
  const save = async () => {
    if (busy) return;
    const parsed = sourcePrototypeInputSchema.safeParse(draft);
    if (!parsed.success) {
      setError("请填写原型名称、功能说明，并提供有效的本地源码文件");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (onCommit) {
        await onCommit(parsed.data);
      } else {
        const request = { kind: "prototype" as const, title: parsed.data.title, document: parsed.data };
        const body = JSON.stringify(request);
        if (requestRef.current?.body !== body) requestRef.current = { body, key: `source-prototype:${crypto.randomUUID()}` };
        const result = await creation.mutateAsync({ request, idempotencyKey: requestRef.current.key });
        if (!session.isCurrent()) return;
        await onCreated?.(result);
      }
      if (session.isCurrent()) onOpenChange(false);
    } catch (cause) {
      if (session.isCurrent()) setError(cause instanceof Error && cause.message ? cause.message : "源码原型保存失败，请重试");
    } finally {
      if (session.isCurrent()) setSaving(false);
    }
  };
  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen); }}>
    <DialogContent showCloseButton={false} className="flex max-h-[90dvh] w-[960px] flex-col gap-0 overflow-hidden border-white/10 bg-[#202124] p-0 text-[#e8eaed] max-sm:p-0">
      <div className="space-y-1 border-b border-white/10 px-6 py-4">
        <DialogTitle>{document ? "编辑源码原型" : "导入源码原型"}</DialogTitle>
        <DialogDescription className="text-[#aeb3bb]">编辑 React 页面，保存后构建独立预览，并保留可回看的版本。</DialogDescription>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        <div className="flex flex-wrap gap-2">
          <input accept="application/json,.json" className="sr-only" disabled={busy} onChange={(event) => { void importProject(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} ref={inputRef} type="file" />
          <button className="rounded-md border border-white/15 px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => inputRef.current?.click()} type="button">选择工程 JSON</button>
          {!document && <button className="rounded-md border border-white/15 px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => { const next = sourcePrototypeSample(draft.documentId); setDraft(next); setSelectedFile(next.entryFile); setError(null); }} type="button">加载交互示例</button>}
        </div>
        <label className="block text-sm">原型名称<input className="mt-1 block w-full rounded-md border border-white/15 bg-black/20 p-2" disabled={busy} onChange={(event) => update({ title: event.target.value })} value={draft.title} /></label>
        <label className="block text-sm">功能说明<textarea className="mt-1 block w-full resize-y rounded-md border border-white/15 bg-black/20 p-2" disabled={busy} onChange={(event) => update({ summary: event.target.value })} rows={2} value={draft.summary} /></label>
        <label className="block text-sm">源码文件<select className="mt-1 block w-full rounded-md border border-white/15 bg-[#18191b] p-2" disabled={busy} onChange={(event) => setSelectedFile(event.target.value)} value={selected.path}>{draft.files.map((file) => <option key={file.path} value={file.path}>{file.path}{file.path === draft.entryFile ? " · 入口" : ""}</option>)}</select></label>
        <textarea aria-label={`编辑 ${selected.path}`} className="block min-h-[260px] w-full resize-y rounded-md border border-white/15 bg-[#111214] p-3 font-mono text-xs leading-5 text-[#dce0e7]" disabled={busy} onChange={(event) => update({ files: draft.files.map((file) => file.path === selected.path ? { ...file, content: event.target.value } : file) })} spellCheck={false} value={selected.content} />
        {error && <p className="rounded-md bg-red-950/30 p-3 text-sm text-red-200" role="alert">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/10 px-6 py-4">
        <button className="rounded-full border border-white/15 px-4 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => onOpenChange(false)} type="button">取消</button>
        <button className="rounded-full bg-[#c9b3ff] px-4 py-2 text-sm font-semibold text-[#241832] disabled:opacity-50" disabled={busy} onClick={() => void save()} type="button">{saving ? "正在构建并保存…" : document ? "保存新版本" : "构建并导入"}</button>
      </div>
    </DialogContent>
  </Dialog>;
}
