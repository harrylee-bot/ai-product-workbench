"use client";

import { FormEvent, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button, TextArea } from "@/components/ui";

export type Phase1Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export function ChatPanel({
  messages,
  disabled,
  sending,
  onSend,
}: {
  messages: Phase1Message[];
  disabled?: boolean;
  sending?: boolean;
  onSend: (content: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || disabled || sending) return;
    await onSend(content);
    setDraft("");
  }

  return (
    <section className="flex min-h-0 flex-col border-r border-gray-200 bg-[#F8FAFC]">
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <div className="text-sm font-semibold text-gray-950">智能输入</div>
        <div className="mt-1 text-xs text-gray-500">只需要说出目标，系统自动完成决策与生成</div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length ? (
          messages.map((message) => (
            <div
              key={message.id}
              className={[
                "max-w-[88%] rounded-lg px-3 py-2 text-sm leading-6 shadow-sm",
                message.role === "user"
                  ? "ml-auto bg-gray-950 text-white"
                  : "mr-auto border border-gray-200 bg-white text-gray-700",
              ].join(" ")}
            >
              {toChineseText(message.content)}
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
            输入一句产品目标，系统会自动经过约束、决策、进化与统一编排，并生成需求结果、设计结果和执行路径。
          </div>
        )}
      </div>
      <form onSubmit={submit} className="border-t border-gray-200 bg-white p-3">
        <TextArea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled || sending}
          placeholder={sending ? "系统正在处理..." : "输入你的需求..."}
          className="min-h-[88px]"
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" disabled={disabled || sending || !draft.trim()}>
            <Sparkles className="h-4 w-4" />
            {sending ? "生成中" : "发送意图"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function toChineseText(value: string) {
  return value
    .replace(/AI Product Workbench/g, "智能产品工作台")
    .replace(/AI Product OS/g, "智能产品操作系统")
    .replace(/AI Product Company/g, "智能产品公司")
    .replace(/Triple System Fusion/g, "三系统融合")
    .replace(/Triple System/g, "三系统融合")
    .replace(/Constraint System/g, "约束系统")
    .replace(/Decision System/g, "决策系统")
    .replace(/Evolution System/g, "进化系统")
    .replace(/Constraint/g, "约束系统")
    .replace(/Decision/g, "决策系统")
    .replace(/Evolution/g, "进化系统")
    .replace(/Patch Preview/g, "补丁预览")
    .replace(/PatchDraft/g, "补丁草稿")
    .replace(/Patch/g, "补丁")
    .replace(/Prototype/g, "原型")
    .replace(/PRD/g, "需求文档")
    .replace(/QA/g, "质检")
    .replace(/AI/g, "智能");
}
