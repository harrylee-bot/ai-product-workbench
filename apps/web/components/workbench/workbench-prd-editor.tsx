"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import {
  canonicalJson,
  prdDocumentSchema,
  type PrdDocument,
} from "@workbench/workbench-contracts";
import {
  CheckIcon,
  LoaderCircleIcon,
  PencilIcon,
  Redo2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyTiptapToPrdDocument,
  prdDocumentToTiptap,
  workbenchPrdExtensions,
} from "../../lib/workbench/prd-editor";
import type { WorkbenchArtifactReference } from "./workbench-artifact-reference";
import { WorkbenchPrdDiagramCanvas } from "./workbench-prd-diagram-canvas";

type PrdDocumentCommit = (
  reference: WorkbenchArtifactReference,
  document: PrdDocument,
) => Promise<void>;

export function WorkbenchPrdArtifactEditor({
  document,
  editingBusy = false,
  onDocumentCommit,
  reference,
}: {
  document: PrdDocument;
  editingBusy?: boolean;
  onDocumentCommit: PrdDocumentCommit;
  reference: WorkbenchArtifactReference;
}) {
  const [draft, setDraft] = useState(document);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baselineRef = useRef(document);
  const baselineVersionRef = useRef(reference.artifactVersionId);
  const editor = useEditor({
    extensions: workbenchPrdExtensions,
    content: prdDocumentToTiptap(document),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "PRD 编辑器",
        class: "min-h-full outline-none",
        role: "textbox",
      },
    },
    onUpdate({ editor: activeEditor }) {
      const baseline = baselineRef.current;
      const next = applyTiptapToPrdDocument(baseline, activeEditor.getJSON());
      setDraft(next);
      setDirty(canonicalJson(next) !== canonicalJson(baseline));
      setError(null);
    },
  }, [reference.artifactVersionId]);

  useEffect(() => {
    if (
      !editor
      || dirty
      || saving
      || baselineVersionRef.current === reference.artifactVersionId
    ) return;
    baselineRef.current = document;
    baselineVersionRef.current = reference.artifactVersionId;
    editor.commands.setContent(prdDocumentToTiptap(document), { emitUpdate: false });
    setDraft(document);
    setError(null);
  }, [dirty, document, editor, reference.artifactVersionId, saving]);

  useEffect(() => {
    editor?.setEditable(!saving && !editingBusy);
  }, [editingBusy, editor, saving]);

  const cancel = useCallback(() => {
    const baseline = baselineRef.current;
    editor?.commands.setContent(prdDocumentToTiptap(baseline), { emitUpdate: false });
    setDraft(baseline);
    setDirty(false);
    setError(null);
  }, [editor]);

  const save = useCallback(async () => {
    if (!dirty || saving || editingBusy) return;
    const parsed = prdDocumentSchema.safeParse({
      ...draft,
      revision: {
        ...draft.revision,
        number: Math.max(draft.revision.number, baselineRef.current.revision.number) + 1,
        changedAt: new Date().toISOString(),
        summary: draft.revision.summary.trim() || "Manual PRD edit",
      },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "PRD 内容不完整");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onDocumentCommit(reference, parsed.data);
      baselineRef.current = parsed.data;
      editor?.commands.setContent(prdDocumentToTiptap(parsed.data), { emitUpdate: false });
      setDraft(parsed.data);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PRD 保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, editingBusy, editor, onDocumentCommit, reference, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if (event.key === "Escape" && dirty && !saving) cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, dirty, save, saving]);

  const busy = saving || editingBusy;
  return (
    <article
      className="relative h-full w-full overflow-auto break-words bg-[#1d1d1f] px-[38px] py-[34px] text-[#e8eaed] [overflow-wrap:anywhere]"
      data-prd-editor="active"
    >
      <div className="absolute right-[38px] top-[34px] z-10 flex items-center gap-[8px] bg-[#1d1d1f] py-[2px]">
        {error && <span className="max-w-[220px] text-[12px] text-[#f2a6a6]">{error}</span>}
        <button
          aria-label="撤销 PRD 编辑"
          className="inline-flex size-[30px] items-center justify-center rounded-[6px] border border-white/[0.14] text-[#c7cad0] transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || !editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
          type="button"
        >
          <Undo2Icon className="size-[15px]" />
        </button>
        <button
          aria-label="重做 PRD 编辑"
          className="inline-flex size-[30px] items-center justify-center rounded-[6px] border border-white/[0.14] text-[#c7cad0] transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || !editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
          type="button"
        >
          <Redo2Icon className="size-[15px]" />
        </button>
        {dirty && !busy && (
          <button
            aria-label="取消 PRD 编辑"
            className="inline-flex size-[30px] items-center justify-center rounded-[6px] border border-white/[0.14] text-[#c7cad0] transition-colors hover:bg-white/[0.08]"
            onClick={cancel}
            type="button"
          >
            <XIcon className="size-[15px]" />
          </button>
        )}
        <button
          aria-label={busy ? "正在保存 PRD" : "保存 PRD"}
          className="inline-flex size-[30px] items-center justify-center rounded-[6px] border border-[#7467f6]/60 bg-[#7467f6]/20 text-[#e4e1ff] transition-colors hover:bg-[#7467f6]/35 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!dirty || busy}
          onClick={() => void save()}
          type="button"
        >
          {busy ? <LoaderCircleIcon className="size-[15px] animate-spin" /> : dirty ? <CheckIcon className="size-[15px]" /> : <PencilIcon className="size-[15px]" />}
        </button>
      </div>
      {document.protocol === "workbench.prd.v2" && (
        <section className="mb-[34px] border-b border-white/[0.12] pb-[34px] pt-[48px]" data-prd-editor-diagrams>
          {document.sections.businessRequirements.flowAndPages.diagrams.map((diagram) => (
            <figure className="mb-[28px] last:mb-0" key={diagram.id}>
              <figcaption>
                <h2 className="text-[18px] font-semibold text-[#f1f3f4]">{diagram.title}</h2>
                <p className="mt-[5px] text-[13px] leading-[21px] text-[#aeb4bd]">{diagram.description}</p>
              </figcaption>
              <WorkbenchPrdDiagramCanvas diagram={diagram} />
            </figure>
          ))}
        </section>
      )}
      <EditorContent
        className="workbench-prd-editor-content min-w-0 break-words [overflow-wrap:anywhere]"
        editor={editor}
      />
    </article>
  );
}
