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
import { Rail } from "./rail";

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

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
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
    if (!latestArtifact) return;
    if (autoOpenedArtifactIdRef.current === latestArtifact.id) return;

    autoOpenedArtifactIdRef.current = latestArtifact.id;
    setArtifact((currentArtifact) => ({
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
    }));
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
    const shouldSettle =
      status === "error" ||
      runtimeProcess.status === "failed" ||
      runtimeProcess.status === "cancelled";
    if (!shouldSettle) return;

    setArtifact((currentArtifact) => {
      if (currentArtifact.status !== "streaming") return currentArtifact;
      if (
        currentArtifact.documentId === "init" &&
        !currentArtifact.content.trim()
      ) {
        if (currentArtifact.isVisible) {
          const startedAt = optimisticCanvasStartedAtRef.current ?? Date.now();
          const remainingMs =
            2400 - Math.max(0, Date.now() - startedAt);

          if (remainingMs > 0) {
            window.setTimeout(() => {
              setArtifact((latestArtifact) => {
                if (
                  latestArtifact.documentId !== "init" ||
                  latestArtifact.status !== "streaming" ||
                  latestArtifact.content.trim()
                ) return latestArtifact;
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
      return { ...currentArtifact, status: "idle" };
    });
  }, [runtimeProcess.status, setArtifact, status]);

  return (
    <>
      {/* ── Gemini three-column shell ── */}
      <div
        className={cn(
          "gemini-shell",
          !isArtifactVisible && "is-canvas-closed"
        )}
      >
        {/* ── Rail column ── */}
        <Rail />

        {/* ── Chat column ── */}
        <div className="chat-pane">
          {/* scroll area */}
          <div className="chat-scroll">
            <ChatHeader
              chatId={chatId}
              isReadonly={isReadonly}
              selectedVisibilityType={visibilityType}
            />

            {isLoading && messages.length === 0 ? (
              <div className="flex flex-1 flex-col gap-4 p-6">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3 animate-pulse">
                    <div className="size-8 shrink-0 rounded-lg bg-[#27282a]" />
                    <div className="flex flex-1 flex-col gap-2 pt-1">
                      <div className="h-4 w-3/4 rounded bg-[#27282a]" />
                      <div className="h-4 w-1/2 rounded bg-[#27282a]/70" />
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
          </div>

          {/* sticky prompt bar */}
          <div className="prompt-row">
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

        {/* ── Canvas column ── */}
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;

    for (let pi = (message.parts?.length ?? 0) - 1; pi >= 0; pi--) {
      const part = message.parts?.[pi] as
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
