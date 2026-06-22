"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FileText, PencilLine } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import {
  compactNumber,
  sectionEditKey,
  splitParagraphs,
  toChineseText,
} from "./helpers";
import type { Phase1PrdPreview } from "./types";

export function PrdPreviewView({ prdPreview }: { prdPreview?: Phase1PrdPreview | null }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [sectionEdits, setSectionEdits] = useState<Record<string, string>>({});
  const [draftText, setDraftText] = useState("");
  const selectedSectionRef = useRef<HTMLElement | null>(null);
  const editTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setSelectedIndex(0);
    setEditingIndex(null);
    setSectionEdits({});
    setDraftText("");
  }, [prdPreview?.id, prdPreview?.title]);

  useEffect(() => {
    selectedSectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (editingIndex !== null) {
      editTextAreaRef.current?.focus();
    }
  }, [editingIndex]);

  if (!prdPreview) {
    return (
      <EmptyPreview
        title="暂无需求文档"
        description="发送需求后，系统会在完成约束、决策、进化流程后生成一份可预览需求文档。"
      />
    );
  }

  const documentKey = prdPreview.id ?? prdPreview.title;
  const sections = prdPreview.sections.map((section, index) => ({
    ...section,
    title: toChineseText(section.title),
    content: toChineseText(sectionEdits[sectionEditKey(documentKey, index)] ?? section.content),
  }));
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, sections.length - 1));
  const selectedSection = sections[safeSelectedIndex] ?? sections[0];
  const totalCharacters = sections.reduce((sum, section) => sum + section.content.replace(/\s+/g, "").length, 0);
  const readMinutes = Math.max(1, Math.ceil(totalCharacters / 500));

  const beginEdit = (index: number) => {
    const section = sections[index];
    if (!section) return;
    setSelectedIndex(index);
    setEditingIndex(index);
    setDraftText(section.content);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    setSectionEdits((current) => ({
      ...current,
      [sectionEditKey(documentKey, editingIndex)]: draftText.trim() || sections[editingIndex]?.content || "",
    }));
    setEditingIndex(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setDraftText("");
  };

  const generateAcceptanceDraft = () => {
    const section = sections[safeSelectedIndex];
    if (!section) return;
    setEditingIndex(safeSelectedIndex);
    setDraftText([
      section.content,
      "",
      "验收标准：",
      "1. 用户能清楚理解该段落描述的目标和边界。",
      "2. 相关状态、异常和反馈路径在原型中有对应表达。",
      "3. QA 能依据本段内容完成回归检查。",
    ].join("\n"));
  };

  return (
    <div className="space-y-3">
      <div className="rounded-[var(--radius-panel)] border border-gray-200 bg-white px-4 py-3 shadow-[var(--shadow-control)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-700">
              <FileText className="h-4 w-4" />
              需求文档
            </div>
            <h2 className="mt-2 text-lg font-semibold leading-tight text-gray-950">{toChineseText(prdPreview.title)}</h2>
          </div>
          <Badge tone="info" className="bg-sky-50">阅读态</Badge>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <Metric label="章节" value={sections.length} />
          <Metric label="阅读" value={`${readMinutes} 分钟`} />
          <Metric label="字符" value={compactNumber(totalCharacters)} />
        </div>
      </div>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[190px_minmax(0,1fr)]">
        <div className="space-y-2 rounded-[var(--radius-panel)] border border-gray-200 bg-white p-2 shadow-[var(--shadow-control)]">
          <div className="flex items-center justify-between px-1">
            <div className="text-xs font-semibold text-gray-500">文档目录</div>
            <Badge tone="neutral" className="bg-gray-50">{safeSelectedIndex + 1}/{sections.length}</Badge>
          </div>
          <div className="space-y-1">
            {sections.map((section, index) => {
              const selected = index === safeSelectedIndex;
              return (
                <button
                  key={`${section.title}-${index}`}
                  type="button"
                  onClick={() => {
                    setSelectedIndex(index);
                    cancelEdit();
                  }}
                  aria-current={selected ? "true" : undefined}
                  title={section.title}
                  className={[
                    "w-full rounded-[10px] border px-2.5 py-2 text-left transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                    selected
                      ? "border-blue-200 bg-blue-50 text-blue-900"
                      : "border-transparent bg-white text-gray-600 hover:border-gray-200 hover:bg-gray-50 hover:text-gray-950",
                  ].join(" ")}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold",
                        selected ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500",
                      ].join(" ")}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 truncate text-xs font-semibold">{section.title}</span>
                  </div>
                  <div className="mt-1 line-clamp-2 break-words text-[11px] leading-4 opacity-75">{section.content}</div>
                </button>
              );
            })}
          </div>
        </div>

        <section ref={selectedSectionRef} className="min-w-0 scroll-mt-3 rounded-[var(--radius-panel)] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
          <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-950 text-xs font-semibold text-white">
                  {safeSelectedIndex + 1}
                </span>
                <h3 className="min-w-0 truncate text-sm font-semibold text-gray-950" title={selectedSection.title}>{selectedSection.title}</h3>
              </div>
              <div className="mt-1 text-xs text-gray-500">{selectedSection.content.replace(/\s+/g, "").length} 字符</div>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => beginEdit(safeSelectedIndex)} title="编辑当前段落">
              <PencilLine className="h-4 w-4" />
              编辑段落
            </Button>
          </div>

          <div className="space-y-3 px-4 py-3 pb-6">
            {splitParagraphs(selectedSection.content).map((paragraph, index) => (
              <p key={`${safeSelectedIndex}-${index}`} className="break-words whitespace-pre-wrap rounded-[12px] border border-transparent px-3 py-2 text-sm leading-7 text-gray-600 hover:border-blue-100 hover:bg-blue-50/40">
                {paragraph}
              </p>
            ))}
          </div>

          <div className="sticky bottom-2 mx-3 mb-3 rounded-[14px] border border-blue-100 bg-white/95 p-2.5 shadow-[var(--shadow-float)] backdrop-blur">
            {editingIndex === safeSelectedIndex ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-blue-700">段落编辑器</div>
                  <Badge tone="accent" className="bg-blue-50">局部草稿</Badge>
                </div>
                <textarea
                  ref={editTextAreaRef}
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                  aria-label="段落编辑内容"
                  rows={5}
                  className="block max-h-[180px] min-h-[120px] w-full resize-none rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:bg-white focus:ring-3 focus:ring-gray-950/10"
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={cancelEdit} title="取消编辑">
                    取消
                  </Button>
                  <Button type="button" size="sm" onClick={saveEdit} disabled={!draftText.trim()} title={draftText.trim() ? "保存段落草稿" : "请输入段落内容"}>
                    <Check className="h-4 w-4" />
                    保存草稿
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-gray-950" title={selectedSection.title}>{selectedSection.title}</div>
                  <div className="text-xs text-gray-500">选区可进入局部段落编辑</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => beginEdit(safeSelectedIndex)} title="改写当前段落">
                    改写
                  </Button>
                  <Button type="button" size="sm" onClick={generateAcceptanceDraft} title="为当前段落生成验收点">
                    生成验收点
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-sky-200 bg-white px-2 py-2">
      <div className="font-semibold text-gray-950">{value}</div>
      <div className="text-gray-500">{label}</div>
    </div>
  );
}
