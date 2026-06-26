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

export function PrdPreviewView({
  prdPreview,
  savingSectionId,
  onSaveSection,
}: {
  prdPreview?: Phase1PrdPreview | null;
  savingSectionId?: string;
  onSaveSection?: (input: { sectionId: string; content: string }) => Promise<void> | void;
}) {
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
        description="发送需求后，系统会基于产品状态生成一份可预览需求文档。"
      />
    );
  }

  const documentKey = prdPreview.id ?? prdPreview.title;
  const sections = prdPreview.sections.map((section, index) => {
    const stableSectionId = section.id || `section-${index + 1}`;
    return {
      ...section,
      id: stableSectionId,
      title: toChineseText(section.title),
      content: toChineseText(sectionEdits[sectionEditKey(documentKey, stableSectionId)] ?? section.content),
    };
  });
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, sections.length - 1));
  const selectedSection = sections[safeSelectedIndex] ?? sections[0];
  const totalCharacters = sections.reduce((sum, section) => sum + section.content.replace(/\s+/g, "").length, 0);
  const readMinutes = Math.max(1, Math.ceil(totalCharacters / 500));

  if (!sections.length) {
    return (
      <EmptyPreview
        title="暂无章节"
        description="需求文档已创建，但当前没有可展示的正文段落。"
      />
    );
  }

  const beginEdit = (index: number) => {
    const section = sections[index];
    if (!section) return;
    setSelectedIndex(index);
    setEditingIndex(index);
    setDraftText(section.content);
  };

  const saveEdit = async () => {
    if (editingIndex === null) return;
    const section = sections[editingIndex];
    if (!section) return;
    const content = draftText.trim() || section.content || "";
    if (onSaveSection) {
      await onSaveSection({ sectionId: section.id, content });
    }
    setSectionEdits((current) => ({
      ...current,
      [sectionEditKey(documentKey, section.id)]: content,
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

      <section className="min-w-0 scroll-mt-3 rounded-[var(--radius-panel)] border border-gray-200 bg-white shadow-[var(--shadow-control)]">
        <div className="divide-y divide-gray-100">
          {sections.map((section, index) => {
            const selected = index === safeSelectedIndex;
            return (
              <article
                key={section.id}
                data-section-id={section.id}
                data-section-type={section.type}
                ref={selected ? selectedSectionRef : null}
                tabIndex={0}
                aria-current={selected ? "true" : undefined}
                className={[
                  "scroll-mt-3 px-4 py-3 transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                  selected ? "bg-blue-50/45" : "bg-white hover:bg-gray-50",
                ].join(" ")}
                onClick={() => {
                  if (index !== safeSelectedIndex) {
                    setSelectedIndex(index);
                    cancelEdit();
                  }
                }}
                onDoubleClick={() => beginEdit(index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedIndex(index);
                    cancelEdit();
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={[
                          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
                          selected ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600",
                        ].join(" ")}
                      >
                        {index + 1}
                      </span>
                      <h3 className="min-w-0 truncate text-sm font-semibold text-gray-950" title={section.title}>{section.title}</h3>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">{section.content.replace(/\s+/g, "").length} 字符</div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={(event) => {
                      event.stopPropagation();
                      beginEdit(index);
                    }}
                    title="编辑当前段落"
                    className="shrink-0"
                  >
                    <PencilLine className="h-4 w-4" />
                    编辑段落
                  </Button>
                </div>

                <div className="mt-3 space-y-3">
                  {sectionContentBlocks(section).map((block) => (
                    <div key={block.id} data-block-id={block.id} data-block-type={block.type}>
                      {splitParagraphs(block.content).map((paragraph, splitIndex) => (
                        <p
                          key={`${block.id}-${splitIndex}`}
                          className={[
                            "break-words whitespace-pre-wrap rounded-[12px] border border-transparent px-3 py-2 text-sm leading-7 text-gray-600 hover:border-blue-100 hover:bg-blue-50/40",
                            block.type === "warning" ? "border-amber-100 bg-amber-50 text-amber-800" : "",
                            block.type === "info" ? "border-sky-100 bg-sky-50 text-sky-800" : "",
                            block.type === "quote" ? "border-l-4 border-l-gray-300 bg-gray-50" : "",
                          ].join(" ")}
                        >
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
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
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void saveEdit()}
                  disabled={!draftText.trim() || savingSectionId === sections[editingIndex]?.id}
                  title={draftText.trim() ? "保存段落" : "请输入段落内容"}
                >
                  <Check className="h-4 w-4" />
                  {savingSectionId === sections[editingIndex]?.id ? "保存中" : "保存"}
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
  );
}

function sectionContentBlocks(section: Phase1PrdPreview["sections"][number]) {
  const editedContent = section.content;
  if (!section.blocks?.length) {
    return [{
      id: `${section.id}:body`,
      type: "paragraph" as const,
      content: editedContent,
    }];
  }
  const originalBlockContent = section.blocks.map((block) => block.content).join("\n\n");
  if (editedContent && editedContent !== originalBlockContent) {
    return [{
      id: `${section.id}:draft`,
      type: "paragraph" as const,
      content: editedContent,
    }];
  }
  return section.blocks;
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-sky-200 bg-white px-2 py-2">
      <div className="font-semibold text-gray-950">{value}</div>
      <div className="text-gray-500">{label}</div>
    </div>
  );
}
