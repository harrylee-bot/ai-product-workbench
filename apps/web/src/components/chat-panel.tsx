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
        <div className="text-sm font-semibold text-gray-950">Chat</div>
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
              {message.content}
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
            输入产品需求后，系统会先进入 Constraint、Decision、Evolution 三系统，再进入 Orchestrator 和 Patch Preview。
          </div>
        )}
      </div>
      <form onSubmit={submit} className="border-t border-gray-200 bg-white p-3">
        <TextArea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled || sending}
          placeholder={disabled ? "请先选择项目" : "输入需求或优化目标..."}
          className="min-h-[88px]"
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" disabled={disabled || sending || !draft.trim()}>
            <Sparkles className="h-4 w-4" />
            {sending ? "决策中" : "AI优化"}
          </Button>
        </div>
      </form>
    </section>
  );
}
