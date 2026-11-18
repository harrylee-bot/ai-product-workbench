// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/right-panel/chat-tab/chat-input/index.tsx
// Commit: 423e2e924366419e418ee049093872d535eea41a. See third_party/onlook.
// Modified: bottom dock, controlled per-project draft, business request callback,
// attachments instead of sandbox context, explicit discussion mode, no queuing,
// natural keyboard traversal.
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Paperclip, Camera } from "lucide-react";
export function ChatInput({
  value,
  onChange,
  onSendMessage,
  onFiles,
  onScreenshot,
  isStreaming,
  disabled,
  context,
  controls,
  attachments,
  error,
  discussion = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSendMessage: () => Promise<void>;
  onFiles: (files: File[]) => void;
  onScreenshot: () => Promise<void>;
  isStreaming: boolean;
  disabled: boolean;
  context?: ReactNode;
  controls: ReactNode;
  attachments?: ReactNode;
  error?: string;
  discussion?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null),
    fileRef = useRef<HTMLInputElement>(null);
  const [isComposing, setIsComposing] = useState(false),
    [isDragging, setIsDragging] = useState(false),
    [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sendingRef=useRef(false);
  const inputEmpty = !value.trim();
  useEffect(() => {
    const node = textareaRef.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = `${Math.min(132, node.scrollHeight)}px`;
    }
  }, [value]);
  const sendMessage = async () => {
    if (inputEmpty || disabled || isStreaming || sendingRef.current) return;
    sendingRef.current=true;setSending(true);
    try {
      await onSendMessage();
    } finally {
      sendingRef.current=false;setSending(false);
    }
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !isComposing &&
      !e.nativeEvent.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      e.stopPropagation();
      void sendMessage();
    }
  };
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) {
      e.preventDefault();
      onFiles(files);
    }
  };
  return (
    <section
      className="studio-composer"
      data-dragging={isDragging}
      aria-label="需求输入"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files.length)
          onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {context}
      {attachments}
      <textarea
        ref={textareaRef}
        rows={1}
        enterKeyHint="send"
        aria-label="描述需求或修改"
        placeholder={
          discussion
            ? "说说本次需求，或继续修改上方的改动摘要…"
            : "描述你的产品想法，或选中元素提出修改…"
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
      />
      <div className="studio-composer-controls">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          title="添加图片或文档"
          aria-label="添加附件"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={17} />
        </button>
        <button
          type="button"
          title="屏幕截图"
          aria-label="屏幕截图"
          onClick={() => void onScreenshot()}
        >
          <Camera size={17} />
        </button>
        <button className="studio-input-settings-toggle" type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}>输入设置</button>
        <div className="studio-input-settings" data-open={settingsOpen}>{controls}</div>
        <button
          type="button"
          className="studio-send"
          aria-label="发送需求"
          title={
            isStreaming
              ? discussion
                ? "正在发送本条需求，请稍候"
                : "等待当前运行完成，或先停止"
              : "Enter 发送，Shift+Enter 换行"
          }
          disabled={disabled || inputEmpty || isStreaming || sending}
          onClick={() => void sendMessage()}
        >
          <ArrowUp size={18} />
        </button>
      </div>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
