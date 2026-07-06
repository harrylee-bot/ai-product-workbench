"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveChat } from "@/hooks/use-active-chat";
import {
  initialArtifactData,
  useArtifact,
  useArtifactSelector,
} from "@/hooks/use-artifact";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Artifact } from "./artifact";
import { ChatHeader } from "./chat-header";
import { DataStreamHandler } from "./data-stream-handler";
import {
  initialRuntimeProcess,
  useDataStream,
} from "./data-stream-provider";
import { submitEditedMessage } from "./message-editor";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";

export function ChatShell() {
  const {
    chatId,
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    addToolApprovalResponse,
    input,
    setInput,
    visibilityType,
    isReadonly,
    isLoading,
    votes,
    currentModelId,
    setCurrentModelId,
    selectedArtifactMode,
    setSelectedArtifactMode,
    runtimeModel,
    runtimeModels,
    runtimeStatus,
  } = useActiveChat();

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(
    null
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);
  const { artifact, setArtifact } = useArtifact();
  const { runtimeProcess, setRuntimeProcess } = useDataStream();
  const autoOpenedArtifactIdRef = useRef<string | null>(null);
  const optimisticCanvasStartedAtRef = useRef<number | null>(null);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      setArtifact(initialArtifactData);
      setRuntimeProcess(initialRuntimeProcess);
      autoOpenedArtifactIdRef.current = null;
      setEditingMessage(null);
      setAttachments([]);
    }
  }, [chatId, setArtifact, setRuntimeProcess]);

  useEffect(() => {
    const latestArtifact = findLatestMessageArtifact(messages);
    if (!latestArtifact) {
      return;
    }
    if (autoOpenedArtifactIdRef.current === latestArtifact.id) {
      return;
    }

    autoOpenedArtifactIdRef.current = latestArtifact.id;
    setArtifact((currentArtifact) => {
      // Removed streaming race guard: it dropped isVisible:true for a newly arrived
      // document when a prior doc was still streaming. The autoOpenedArtifactIdRef
      // dedup above already prevents re-opening the same doc.
      return {
        ...currentArtifact,
        documentId: latestArtifact.id,
        kind: latestArtifact.kind,
        title: latestArtifact.title,
        content:
          currentArtifact.documentId === latestArtifact.id
            ? currentArtifact.content
            : "",
        status: "idle",
        isVisible: true,
      };
    });
  }, [messages, setArtifact]);

  useEffect(() => {
    if (
      artifact.documentId === "init" &&
      artifact.status === "streaming" &&
      artifact.isVisible
    ) {
      optimisticCanvasStartedAtRef.current ??= Date.now();
      return;
    }

    if (artifact.status !== "streaming") {
      optimisticCanvasStartedAtRef.current = null;
    }
  }, [artifact.documentId, artifact.isVisible, artifact.status]);

  useEffect(() => {
    const shouldSettleOptimisticCanvas =
      status === "error" ||
      runtimeProcess.status === "failed" ||
      runtimeProcess.status === "cancelled";
    if (!shouldSettleOptimisticCanvas) {
      return;
    }

    setArtifact((currentArtifact) => {
      if (currentArtifact.status !== "streaming") {
        return currentArtifact;
      }
      if (
        currentArtifact.documentId === "init" &&
        !currentArtifact.content.trim()
      ) {
        if (currentArtifact.isVisible) {
          const startedAt = optimisticCanvasStartedAtRef.current ?? Date.now();
          const minimumGeneratingMs = 2400;
          const remainingMs =
            minimumGeneratingMs - Math.max(0, Date.now() - startedAt);

          if (remainingMs > 0) {
            window.setTimeout(() => {
              setArtifact((latestArtifact) => {
                if (
                  latestArtifact.documentId !== "init" ||
                  latestArtifact.status !== "streaming" ||
                  latestArtifact.content.trim()
                ) {
                  return latestArtifact;
                }

                optimisticCanvasStartedAtRef.current = null;
                return {
                  ...latestArtifact,
                  status: "idle",
                  content: "生成失败，请重试。",
                  isVisible: true,
                };
              });
            }, remainingMs);

            return currentArtifact;
          }
        }

        optimisticCanvasStartedAtRef.current = null;
        return {
          ...currentArtifact,
          status: "idle",
          content: "生成失败，请重试。",
          isVisible: currentArtifact.isVisible,
        };
      }

      optimisticCanvasStartedAtRef.current = null;
      return {
        ...currentArtifact,
        status: "idle",
      };
    });
  }, [runtimeProcess.status, setArtifact, status]);

  return (
    <>
      <div className="relative flex h-dvh w-full flex-row overflow-hidden bg-background">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_52%_0%,rgba(255,255,255,0.08),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.025),transparent_38%)]" />
        <div
          className={cn(
            "relative z-1 flex min-w-0 flex-col transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            isArtifactVisible
              ? "w-[40%] p-3 pr-0"
              : "mx-auto w-full max-w-[980px] p-3"
          )}
        >
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#101112]/78 shadow-[0_28px_90px_-46px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.045)] backdrop-blur-2xl">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-white/[0.045] to-transparent" />
            <ChatHeader
              chatId={chatId}
              isReadonly={isReadonly}
              selectedVisibilityType={visibilityType}
            />
            {isLoading && messages.length === 0 ? (
              <div className="flex flex-1 flex-col gap-4 p-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3 animate-pulse">
                    <div className="size-8 shrink-0 rounded-lg bg-muted/70" />
                    <div className="flex flex-1 flex-col gap-2 pt-1">
                      <div className="h-4 w-3/4 rounded bg-muted/70" />
                      <div className="h-4 w-1/2 rounded bg-muted/50" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Messages
                addToolApprovalResponse={addToolApprovalResponse}
                chatId={chatId}
                isArtifactVisible={isArtifactVisible}
                isLoading={isLoading}
                isReadonly={isReadonly}
                messages={messages}
                onEditMessage={(msg) => {
                  const text = msg.parts
                    ?.filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("");
                  setInput(text ?? "");
                  setEditingMessage(msg);
                }}
                regenerate={regenerate}
                runStatus={runtimeStatus}
                selectedModelId={currentModelId}
                setMessages={setMessages}
                status={status}
                votes={votes}
              />
            )}

            <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-gradient-to-t from-[#101112] via-[#101112]/92 to-transparent px-2 pt-10 pb-3 md:px-4 md:pb-4">
              {!isReadonly && (
                <MultimodalInput
                  attachments={attachments}
                  chatId={chatId}
                  editingMessage={editingMessage}
                  input={input}
                  isLoading={isLoading}
                  messages={messages}
                  onCancelEdit={() => {
                    setEditingMessage(null);
                    setInput("");
                  }}
                  onModelChange={setCurrentModelId}
                  onArtifactModeChange={setSelectedArtifactMode}
                  runtimeModel={runtimeModel}
                  runtimeModels={runtimeModels}
                  selectedArtifactMode={selectedArtifactMode}
                  selectedModelId={currentModelId}
                  selectedVisibilityType={visibilityType}
                  sendMessage={
                    editingMessage
                      ? async () => {
                          const msg = editingMessage;
                          setEditingMessage(null);
                          await submitEditedMessage({
                            message: msg,
                            text: input,
                            setMessages,
                            regenerate,
                          });
                          setInput("");
                        }
                      : sendMessage
                  }
                  setAttachments={setAttachments}
                  setInput={setInput}
                  setMessages={setMessages}
                  status={status}
                  stop={stop}
                />
              )}
            </div>
          </div>
        </div>

        <Artifact
          addToolApprovalResponse={addToolApprovalResponse}
          attachments={attachments}
          chatId={chatId}
          input={input}
          isReadonly={isReadonly}
          messages={messages}
          regenerate={regenerate}
          selectedModelId={currentModelId}
          selectedVisibilityType={visibilityType}
          sendMessage={sendMessage}
          setAttachments={setAttachments}
          setInput={setInput}
          setMessages={setMessages}
          status={status}
          stop={stop}
          votes={votes}
        />
      </div>

      <DataStreamHandler chatId={chatId} />
    </>
  );
}

function findLatestMessageArtifact(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;

    for (
      let partIndex = (message.parts?.length ?? 0) - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts?.[partIndex] as
        | {
            type?: string;
            state?: string;
            output?: { id?: string; title?: string; kind?: string };
          }
        | undefined;

      if (
        part?.type === "tool-createDocument" &&
        part.state === "output-available" &&
        part.output?.id &&
        (part.output.kind === "text" ||
          part.output.kind === "prototype" ||
          part.output.kind === "prd")
      ) {
        return {
          id: part.output.id,
          title: part.output.title || "产物",
          kind: part.output.kind,
        } as const;
      }
    }
  }

  return null;
}
