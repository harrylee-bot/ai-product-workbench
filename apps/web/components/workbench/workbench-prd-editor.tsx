"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import {
  canonicalJson,
  prdChannelLabels,
  prdDocumentSchema,
  prdSafetyBaselineItems,
  type PrdDocument,
  type PrdDocumentV2,
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
  const [_draft, setDraft] = useState(document);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baselineRef = useRef(document);
  const draftRef = useRef(document);
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
      const next = applyTiptapToPrdDocument(draftRef.current, activeEditor.getJSON());
      draftRef.current = next;
      setDraft(next);
      setDirty(canonicalJson(next) !== canonicalJson(baselineRef.current));
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
    draftRef.current = document;
    setDraft(document);
    setError(null);
  }, [dirty, document, editor, reference.artifactVersionId, saving]);

  useEffect(() => {
    editor?.setEditable(!saving && !editingBusy);
  }, [editingBusy, editor, saving]);

  const cancel = useCallback(() => {
    const baseline = baselineRef.current;
    editor?.commands.setContent(prdDocumentToTiptap(baseline), { emitUpdate: false });
    draftRef.current = baseline;
    setDraft(baseline);
    setDirty(false);
    setError(null);
  }, [editor]);

  const save = useCallback(async () => {
    if (!dirty || saving || editingBusy) return;
    const parsed = prdDocumentSchema.safeParse({
      ...draftRef.current,
      revision: {
        ...draftRef.current.revision,
        number: Math.max(draftRef.current.revision.number, baselineRef.current.revision.number) + 1,
        changedAt: new Date().toISOString(),
        summary: draftRef.current.revision.summary.trim() || "Manual PRD edit",
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
      draftRef.current = parsed.data;
      editor?.commands.setContent(prdDocumentToTiptap(parsed.data), { emitUpdate: false });
      setDraft(parsed.data);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PRD 保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }, [dirty, editingBusy, editor, onDocumentCommit, reference, saving]);

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
  const updateV2 = useCallback((update: (document: PrdDocumentV2) => PrdDocumentV2) => {
    if (draftRef.current.protocol !== "workbench.prd.v2") return;
    const next = update(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    setDirty(canonicalJson(next) !== canonicalJson(baselineRef.current));
    setError(null);
  }, []);
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
      <EditorContent
        className="workbench-prd-editor-content min-w-0 break-words [overflow-wrap:anywhere]"
        editor={editor}
      />
      {draftRef.current.protocol === "workbench.prd.v2" && (
        <PrdStructuredFieldsEditor
          document={draftRef.current}
          disabled={busy}
          onChange={updateV2}
        />
      )}
      {document.protocol === "workbench.prd.v2" && (
        <section className="mt-[34px] border-t border-white/[0.12] pt-[34px]" data-prd-editor-diagrams>
          {document.sections.businessRequirements.flowAndPages.diagrams.map((diagram) => (
            <figure className="mb-[28px] last:mb-0" key={diagram.id}>
              <figcaption>
                <h3 className="text-[18px] font-semibold text-[#f1f3f4]">{diagram.title}</h3>
                <p className="mt-[5px] text-[13px] leading-[21px] text-[#aeb4bd]">{diagram.description}</p>
              </figcaption>
              <WorkbenchPrdDiagramCanvas diagram={diagram} />
            </figure>
          ))}
        </section>
      )}
    </article>
  );
}

function PrdStructuredFieldsEditor({
  document,
  disabled,
  onChange,
}: {
  document: PrdDocumentV2;
  disabled: boolean;
  onChange: (update: (document: PrdDocumentV2) => PrdDocumentV2) => void;
}) {
  return (
    <section className="mt-[34px] border-t border-white/[0.12] pt-[24px]" data-prd-structured-fields>
      <h2 className="text-[20px] font-semibold text-[#f1f3f4]">结构化字段</h2>
      
      {/* Version History Table */}
      <div className="mt-[20px]">
        <h3 className="mb-[8px] text-[16px] font-semibold text-[#f1f3f4]">版本历史</h3>
        <div className="overflow-x-auto border border-white/[0.12]">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="p-[8px] text-left">版本/状态</th>
                <th className="p-[8px] text-left">作者</th>
                <th className="p-[8px] text-left">参与者</th>
                <th className="p-[8px] text-left">起始日期</th>
                <th className="p-[8px] text-left">结束日期</th>
                <th className="p-[8px] text-left">备注</th>
              </tr>
            </thead>
            <tbody>
              {document.versionHistory.map((entry, index) => (
                <tr key={index}>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <select
                      aria-label={`版本${index + 1}状态`}
                      className="w-full min-w-[100px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      value={entry.status}
                      onChange={(e) => onChange((current) => ({
                        ...current,
                        versionHistory: current.versionHistory.map((v, i) =>
                          i === index ? { ...v, status: e.target.value as "讨论稿" | "评审中" | "已定稿" } : v
                        ),
                      }))}
                    >
                      <option value="讨论稿">讨论稿</option>
                      <option value="评审中">评审中</option>
                      <option value="已定稿">已定稿</option>
                    </select>
                  </td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <input
                      type="text"
                      aria-label={`版本${index + 1}作者`}
                      className="w-full min-w-[100px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      value={entry.author}
                      onChange={(e) => onChange((current) => ({
                        ...current,
                        versionHistory: current.versionHistory.map((v, i) =>
                          i === index ? { ...v, author: e.target.value } : v
                        ),
                      }))}
                    />
                  </td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <input
                      type="text"
                      aria-label={`版本${index + 1}参与者`}
                      className="w-full min-w-[150px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      value={entry.participants.join("、")}
                      onChange={(e) => onChange((current) => ({
                        ...current,
                        versionHistory: current.versionHistory.map((v, i) =>
                          i === index ? { ...v, participants: e.target.value.split(/[、,，]/).map(s => s.trim()).filter(Boolean) } : v
                        ),
                      }))}
                    />
                  </td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <input
                      type="date"
                      aria-label={`版本${index + 1}起始日期`}
                      className="w-full min-w-[120px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      value={entry.startDate}
                      onChange={(e) => onChange((current) => ({
                        ...current,
                        versionHistory: current.versionHistory.map((v, i) =>
                          i === index ? { ...v, startDate: e.target.value } : v
                        ),
                      }))}
                    />
                  </td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <input
                      type="date"
                      aria-label={`版本${index + 1}结束日期`}
                      className="w-full min-w-[120px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      value={entry.endDate}
                      onChange={(e) => onChange((current) => ({
                        ...current,
                        versionHistory: current.versionHistory.map((v, i) =>
                          i === index ? { ...v, endDate: e.target.value } : v
                        ),
                      }))}
                    />
                  </td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <input
                      type="text"
                      aria-label={`版本${index + 1}备注`}
                      className="w-full min-w-[200px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      value={entry.notes}
                      onChange={(e) => onChange((current) => ({
                        ...current,
                        versionHistory: current.versionHistory.map((v, i) =>
                          i === index ? { ...v, notes: e.target.value } : v
                        ),
                      }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Channel Table */}
      <div className="mt-[16px] overflow-x-auto border border-white/[0.12]">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><th className="p-[8px] text-left">渠道</th><th className="p-[8px] text-left">是否投放</th></tr></thead>
          <tbody>
            {document.sections.introduction.usageScenarios.channelTable.rows.map((row, index) => (
              <tr key={row.channel}>
                <td className="border-t border-white/[0.08] p-[8px]">{prdChannelLabels[row.channel]}</td>
                <td className="border-t border-white/[0.08] p-[8px]">
                  <input
                    aria-label={`${prdChannelLabels[row.channel]}是否投放`}
                    checked={row.enabled}
                    className="size-[16px]"
                    disabled={disabled}
                    onChange={(event) => onChange((current) => ({
                      ...current,
                      sections: {
                        ...current.sections,
                        introduction: {
                          ...current.sections.introduction,
                          usageScenarios: {
                            ...current.sections.introduction.usageScenarios,
                            channelTable: {
                              ...current.sections.introduction.usageScenarios.channelTable,
                              rows: current.sections.introduction.usageScenarios.channelTable.rows.map((candidate, candidateIndex) => (
                                candidateIndex === index ? { ...candidate, enabled: event.target.checked } : candidate
                              )),
                            },
                          },
                        },
                      },
                    }))}
                    type="checkbox"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-[20px] overflow-x-auto border border-white/[0.12]">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><th className="p-[8px] text-left">安全基线</th><th className="p-[8px] text-left">判定</th><th className="p-[8px] text-left">备注</th></tr></thead>
          <tbody>
            {document.sections.safetyBaseline.rows.map((row, index) => {
              const item = prdSafetyBaselineItems[index];
              if (!item) return null;
              return (
                <tr key={row.sequence}>
                  <td className="max-w-[420px] border-t border-white/[0.08] p-[8px]">{item.requirement}</td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <select
                      aria-label={`${row.sequence}安全基线判定`}
                      className="bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      onChange={(event) => onChange((current) => ({
                        ...current,
                        sections: {
                          ...current.sections,
                          safetyBaseline: {
                            ...current.sections.safetyBaseline,
                            rows: current.sections.safetyBaseline.rows.map((candidate, candidateIndex) => (
                              candidateIndex === index
                                ? { ...candidate, applicability: event.target.value as typeof candidate.applicability }
                                : candidate
                            )),
                          },
                        },
                      }))}
                      value={row.applicability}
                    >
                      <option value="是">是</option>
                      <option value="否">否</option>
                      <option value="不涉及">不涉及</option>
                    </select>
                  </td>
                  <td className="border-t border-white/[0.08] p-[8px]">
                    <input
                      aria-label={`${row.sequence}安全基线备注`}
                      className="min-w-[220px] bg-[#242629] px-[6px] py-[4px]"
                      disabled={disabled}
                      onChange={(event) => onChange((current) => ({
                        ...current,
                        sections: {
                          ...current.sections,
                          safetyBaseline: {
                            ...current.sections.safetyBaseline,
                            rows: current.sections.safetyBaseline.rows.map((candidate, candidateIndex) => (
                              candidateIndex === index ? { ...candidate, remarks: event.target.value || null } : candidate
                            )),
                          },
                        },
                      }))}
                      value={row.remarks ?? ""}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
