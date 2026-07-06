import type { UseChatHelpers } from "@ai-sdk/react";
import { formatDistance } from "date-fns";
import { zhCN } from "date-fns/locale";
import equal from "fast-deep-equal";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckIcon,
  CloudIcon,
  Code2Icon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  MoreVerticalIcon,
  PanelRightOpenIcon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  type Dispatch,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import useSWR from "swr";
import { useWindowSize } from "usehooks-ts";
import { codeArtifact } from "@/artifacts/code/client";
import { imageArtifact } from "@/artifacts/image/client";
import { prototypeArtifact } from "@/artifacts/prototype/client";
import { sheetArtifact } from "@/artifacts/sheet/client";
import { textArtifact } from "@/artifacts/text/client";
import { useArtifact } from "@/hooks/use-artifact";
import { downloadApiFile } from "@/lib/api/download";
import type { Document, Vote } from "@/lib/api/types";
import {
  getDocumentsById,
  saveDocumentContent,
} from "@/lib/api/nest-client";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ArtifactActions } from "./artifact-actions";
import { ArtifactCloseButton } from "./artifact-close-button";
import type {
  ArtifactActionContext,
  ArtifactToolbarContext,
} from "./create-artifact";
import { LoaderIcon } from "./icons";
import { Toolbar } from "./toolbar";
import { VersionFooter } from "./version-footer";
import type { VisibilityType } from "./visibility-selector";

export const artifactDefinitions = [
  textArtifact,
  codeArtifact,
  imageArtifact,
  sheetArtifact,
  prototypeArtifact,
];
export type ArtifactKind = (typeof artifactDefinitions)[number]["kind"] | "prd";

export type UIArtifact = {
  title: string;
  documentId: string;
  kind: ArtifactKind;
  content: string;
  isVisible: boolean;
  status: "streaming" | "idle";
  boundingBox: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
};

function PureArtifact({
  addToolApprovalResponse: _addToolApprovalResponse,
  chatId,
  input: _input,
  setInput: _setInput,
  status,
  stop,
  attachments: _attachments,
  setAttachments: _setAttachments,
  sendMessage,
  messages: _messages,
  setMessages,
  regenerate: _regenerate,
  votes: _votes,
  isReadonly: _isReadonly,
  selectedVisibilityType: _selectedVisibilityType,
  selectedModelId: _selectedModelId,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  votes: Vote[] | undefined;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
}) {
  const { artifact, setArtifact, metadata, setMetadata } = useArtifact();

  const artifactKindForDefinition =
    artifact.kind === "prd" ? "text" : artifact.kind;

  const documentsKey =
    artifact.documentId !== "init" && artifact.status !== "streaming"
      ? `document-${artifact.documentId}-${artifact.kind}`
      : null;

  const isPrototype = artifact.kind === "prototype";

  const {
    data: documents,
    isLoading: isDocumentsFetching,
    mutate: mutateDocuments,
  } = useSWR<Document[]>(
    documentsKey,
    () => getDocumentsById(artifact.documentId, artifact.kind),
    {
      // 原型为一次性快照，404 即永久删除，不重试。
      shouldRetryOnError: !isPrototype,
    },
  );

  const [mode, setMode] = useState<"edit" | "diff">("edit");
  const [document, setDocument] = useState<Document | null>(null);
  const [currentVersionIndex, setCurrentVersionIndex] = useState(-1);

  const artifactContentRef = useRef<HTMLDivElement>(null);
  const userScrolledArtifact = useRef(false);
  const [isContentDirty, setIsContentDirty] = useState(false);

  useEffect(() => {
    if (artifact.status !== "streaming") {
      userScrolledArtifact.current = false;
      return;
    }
    if (userScrolledArtifact.current) {
      return;
    }
    const el = artifactContentRef.current;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
  }, [artifact.status]);

  useEffect(() => {
    if (documents && documents.length > 0) {
      const mostRecentDocument = documents.at(-1);

      if (mostRecentDocument) {
        setDocument(mostRecentDocument);
        setCurrentVersionIndex(documents.length - 1);
        if (artifact.status === "streaming" || !isContentDirty) {
          setArtifact((currentArtifact) => ({
            ...currentArtifact,
            documentId: mostRecentDocument.id,
            kind: mostRecentDocument.kind,
            title: mostRecentDocument.title,
            content: mostRecentDocument.content ?? "",
          }));
        }
      }
    }
  }, [documents, setArtifact, artifact.status, isContentDirty]);

  useEffect(() => {
    mutateDocuments();
  }, [mutateDocuments]);

  const handleContentChange = useCallback(
    (updatedContent: string) => {
      if (!artifact) {
        return;
      }

      mutateDocuments(async (currentDocuments) => {
        if (!currentDocuments) {
          return [];
        }

        const currentDocument = currentDocuments.at(-1);

        if (!currentDocument) {
          setIsContentDirty(false);
          return currentDocuments;
        }

        if ((currentDocument.content ?? "") === updatedContent) {
          setIsContentDirty(false);
          return currentDocuments;
        }

        const savedDocument = await saveDocumentContent(
          artifact.documentId,
          updatedContent,
          artifact.kind,
        );

        setIsContentDirty(false);

        if (!savedDocument) {
          return currentDocuments.map((doc, i) =>
            i === currentDocuments.length - 1
              ? { ...doc, content: updatedContent }
              : doc
          );
        }

        return [...currentDocuments, savedDocument];
      }, { revalidate: false });
    },
    [artifact, mutateDocuments]
  );

  const latestContentRef = useRef<string>("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveContent = useCallback(
    (updatedContent: string, debounce: boolean) => {
      latestContentRef.current = updatedContent;
      setIsContentDirty(true);

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (debounce) {
        saveTimerRef.current = setTimeout(() => {
          handleContentChange(latestContentRef.current);
          saveTimerRef.current = null;
        }, 2000);
      } else {
        handleContentChange(updatedContent);
      }
    },
    [handleContentChange]
  );

  function getDocumentContentById(index: number) {
    if (!documents) {
      return "";
    }
    if (!documents[index]) {
      return "";
    }
    return documents[index].content ?? "";
  }

  const handleVersionChange = (type: "next" | "prev" | "toggle" | "latest") => {
    if (!documents) {
      return;
    }

    if (type === "latest") {
      setCurrentVersionIndex(documents.length - 1);
      setMode("edit");
    }

    if (type === "toggle") {
      setMode((currentMode) => (currentMode === "edit" ? "diff" : "edit"));
    }

    if (type === "prev") {
      if (currentVersionIndex > 0) {
        setCurrentVersionIndex((index) => index - 1);
      }
    } else if (type === "next" && currentVersionIndex < documents.length - 1) {
      setCurrentVersionIndex((index) => index + 1);
    }
  };

  const restoreSelectedVersion = useCallback(async () => {
    if (!documents || currentVersionIndex < 0) {
      return;
    }

    const selectedDocument = documents[currentVersionIndex];
    const selectedContent = selectedDocument?.content ?? "";
    if (!selectedContent) {
      return;
    }

    const savedDocument = await saveDocumentContent(
      artifact.documentId,
      selectedContent,
      artifact.kind,
    );
    if (!savedDocument) {
      return;
    }

    await mutateDocuments((currentDocuments) => {
      const nextDocuments = currentDocuments?.length ? currentDocuments : documents;
      return [...nextDocuments, savedDocument];
    }, { revalidate: false });
    setCurrentVersionIndex((documents.length ? documents.length : 1));
    setMode("edit");
  }, [artifact.documentId, artifact.kind, currentVersionIndex, documents, mutateDocuments]);

  const [isToolbarVisible, setIsToolbarVisible] = useState(true);

  const isCurrentVersion =
    documents && documents.length > 0
      ? currentVersionIndex === documents.length - 1
      : true;

  const { width: windowWidth, height: windowHeight } = useWindowSize();
  const isMobile = windowWidth ? windowWidth < 768 : false;

  const artifactDefinition = artifactDefinitions.find(
    (definition) => definition.kind === artifactKindForDefinition
  );

  if (!artifactDefinition) {
    throw new Error("未找到画布类型定义");
  }

  useEffect(() => {
    if (artifact.documentId !== "init" && artifactDefinition.initialize) {
      artifactDefinition.initialize({
        documentId: artifact.documentId,
        setMetadata,
      });
    }
  }, [artifact.documentId, artifactDefinition, setMetadata]);

  if (!artifact.isVisible && !isMobile) {
    return (
      <div
        aria-hidden="true"
        className="h-dvh w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      />
    );
  }

  if (!artifact.isVisible) {
    return null;
  }

  const consoleError =
    metadata?.outputs
      ?.filter((o: { status: string }) => o.status === "failed")
      .flatMap((o: { contents: { type: string; value: string }[] }) =>
        o.contents.filter((c) => c.type === "text").map((c) => c.value)
      )
      .join("\n") || undefined;

  const isWorkbenchCanvasArtifact =
    artifact.kind === "text" ||
    artifact.kind === "prd" ||
    artifact.kind === "prototype";
  const canvasSaveState = isContentDirty
    ? "saving"
    : artifact.status === "streaming"
      ? "generating"
      : document
        ? "saved"
        : "ready";

  const artifactPanel = (
    <>
      {isWorkbenchCanvasArtifact ? (
        <WorkbenchCanvasHeader
          chatId={chatId}
          content={artifact.content}
          currentVersionIndex={currentVersionIndex}
          documentsCount={documents?.length ?? 0}
          handleVersionChange={handleVersionChange}
          isCurrentVersion={isCurrentVersion}
          kind={artifact.kind}
          mode={mode}
          saveState={canvasSaveState}
          title={artifact.title}
        />
      ) : (
        <div className="flex h-[calc(3.5rem+1px)] shrink-0 items-center justify-between border-b border-border/70 bg-sidebar/70 px-4 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <ArtifactCloseButton />
            <div className="flex flex-col gap-0.5">
              <div className="text-sm font-semibold leading-tight tracking-tight">
                {artifact.title}
              </div>
              <div className="flex items-center gap-2">
                {isContentDirty ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <div className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                    保存中...
                  </div>
                ) : document ? (
                  <div className="text-xs text-muted-foreground">
                    {`${formatDistance(new Date(document.createdAt), new Date(), { addSuffix: true, locale: zhCN })}更新`}
                  </div>
                ) : artifact.status === "streaming" ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <div className="animate-spin">
                      <LoaderIcon size={12} />
                    </div>
                    生成中...
                  </div>
                ) : (
                  <div className="h-3 w-24 animate-pulse rounded bg-muted-foreground/10" />
                )}
                {documents && documents.length > 1 && (
                  <div className="rounded-md border border-border/60 bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                    v{currentVersionIndex + 1}/{documents.length}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        className={cn(
          "relative flex-1",
          artifact.kind === "prototype" ? "overflow-hidden" : "overflow-y-auto",
          isWorkbenchCanvasArtifact ? "bg-[#131314]" : "bg-background/75"
        )}
        data-slot="artifact-content"
        onScroll={() => {
          const el = artifactContentRef.current;
          if (!el) {
            return;
          }
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          userScrolledArtifact.current = !atBottom;
        }}
        ref={artifactContentRef}
      >
        <artifactDefinition.content
          content={
            isCurrentVersion
              ? artifact.content
              : getDocumentContentById(currentVersionIndex)
          }
          currentVersionIndex={currentVersionIndex}
          getDocumentContentById={getDocumentContentById}
          isCurrentVersion={isCurrentVersion}
          isInline={false}
          isLoading={isDocumentsFetching && !artifact.content}
          metadata={metadata}
          mode={mode}
          onSaveContent={saveContent}
          setMetadata={setMetadata}
          status={artifact.status}
          suggestions={[]}
          title={artifact.title}
        />
        <AnimatePresence>
          {isWorkbenchCanvasArtifact && isCurrentVersion ? (
            <WorkbenchCanvasSideTools
              artifact={artifact}
              artifactDefinition={artifactDefinition}
              chatId={chatId}
              consoleError={consoleError}
              currentVersionIndex={currentVersionIndex}
              handleVersionChange={handleVersionChange}
              isCurrentVersion={isCurrentVersion}
              metadata={metadata}
              mode={mode}
              selectedText={
                typeof metadata?.selectedText === "string"
                  ? metadata.selectedText
                  : undefined
              }
              sendMessage={sendMessage}
              setMetadata={setMetadata}
            />
          ) : null}
          {!isWorkbenchCanvasArtifact && isCurrentVersion && (
            <Toolbar
              artifactActions={
                <ArtifactActions
                  artifact={artifact}
                  chatId={chatId}
                  currentVersionIndex={currentVersionIndex}
                  handleVersionChange={handleVersionChange}
                  isCurrentVersion={isCurrentVersion}
                  metadata={metadata}
                  mode={mode}
                  setMetadata={setMetadata}
                />
              }
              artifactKind={artifact.kind}
              content={artifact.content}
              consoleError={consoleError}
              documentId={artifact.documentId}
              isToolbarVisible={isToolbarVisible}
              metadata={metadata}
              onClose={() => {
                setArtifact((prev) => ({ ...prev, isVisible: false }));
              }}
              selectedText={
                typeof metadata?.selectedText === "string"
                  ? metadata.selectedText
                  : undefined
              }
              sendMessage={sendMessage}
              setIsToolbarVisible={setIsToolbarVisible}
              setMessages={setMessages}
              status={status}
              stop={stop}
            />
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {!isCurrentVersion && (
          <VersionFooter
            currentVersionIndex={currentVersionIndex}
            documents={documents}
            handleVersionChange={handleVersionChange}
            mode={mode}
            onRestore={restoreSelectedVersion}
            setMode={setMode}
          />
        )}
      </AnimatePresence>
    </>
  );

  if (isMobile) {
    return (
      <motion.div
        animate={{
          opacity: 1,
          x: 0,
          y: 0,
          height: windowHeight,
          width: "100dvw",
          borderRadius: 0,
        }}
        className="fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden bg-background"
        data-testid="artifact"
        exit={{ opacity: 0, scale: 0.95 }}
        initial={{
          opacity: 1,
          x: artifact.boundingBox.left,
          y: artifact.boundingBox.top,
          height: artifact.boundingBox.height,
          width: artifact.boundingBox.width,
          borderRadius: 50,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        {artifactPanel}
      </motion.div>
    );
  }

  return (
    <div
      className={cn(
        "artifact-panel",
        "h-dvh w-[60%] shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        isWorkbenchCanvasArtifact
          ? "flex bg-background/70 p-3 pl-0"
          : "flex flex-col overflow-hidden"
      )}
      data-testid="artifact"
    >
      {isWorkbenchCanvasArtifact ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[34px] border border-[#3c4043] bg-[#1f1f1f] shadow-[0_22px_58px_rgba(0,0,0,0.42)]">
          {artifactPanel}
        </div>
      ) : (
        artifactPanel
      )}
    </div>
  );
}

function WorkbenchCanvasHeader({
  chatId,
  content,
  currentVersionIndex,
  documentsCount,
  handleVersionChange,
  isCurrentVersion,
  kind,
  mode,
  saveState,
  title,
}: {
  chatId: string;
  content: string;
  currentVersionIndex: number;
  documentsCount: number;
  handleVersionChange: (type: "next" | "prev" | "toggle" | "latest") => void;
  isCurrentVersion: boolean;
  kind: ArtifactKind;
  mode: "edit" | "diff";
  saveState: "generating" | "ready" | "saved" | "saving";
  title: string;
}) {
  const isPrototype = kind === "prototype";
  const safeTitle =
    title?.trim() || (isPrototype ? "未命名原型" : "未命名文档");
  const kindLabel = isPrototype ? "原型" : "文档";
  const saveLabel =
    saveState === "generating"
      ? "正在生成"
      : saveState === "saving"
        ? "正在保存"
        : saveState === "saved"
          ? "已保存"
          : "Canvas";
  const exportEndpoint = isPrototype
    ? `/conversations/${chatId}/export/html`
    : `/conversations/${chatId}/export/word`;
  const exportFilename = isPrototype ? "prototype.html" : "需求说明书.doc";
  const copyContent = stripPrototypePreviewPrefix(content);

  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[#131314] px-3 text-[#e8eaed]">
      <div className="flex min-w-0 items-center gap-2">
        <ArtifactCloseButton />
        <div className="flex min-w-0 items-center gap-2 rounded-full bg-white/[0.06] py-1.5 pr-3 pl-2 text-sm text-[#e8eaed] ring-1 ring-white/[0.08]">
          {isPrototype ? (
            <PanelRightOpenIcon className="size-4 shrink-0 text-[#c4c7c5]" />
          ) : (
            <FileTextIcon className="size-4 shrink-0 text-[#c4c7c5]" />
          )}
          <span className="max-w-[32vw] truncate font-medium leading-none">
            {safeTitle}
          </span>
        </div>
        <div className="hidden h-8 items-center rounded-full bg-white/[0.04] p-0.5 ring-1 ring-white/[0.08] lg:flex">
          <span className="rounded-full bg-white/[0.08] px-2.5 py-1 text-[12px] leading-none text-[#e8eaed]">
            {kindLabel}
          </span>
          {documentsCount > 1 ? (
            <button
              className={cn(
                "rounded-full px-2.5 py-1 text-[12px] leading-none text-[#9aa0a6] transition-colors hover:bg-white/[0.08] hover:text-[#e8eaed]",
                mode === "diff" && "bg-white/[0.08] text-[#e8eaed]"
              )}
              onClick={() => handleVersionChange("toggle")}
              type="button"
            >
              v{Math.max(currentVersionIndex + 1, 1)}/{documentsCount}
            </button>
          ) : null}
        </div>
        <div className="hidden items-center gap-1.5 text-[12px] text-[#9aa0a6] md:flex">
          {saveState === "generating" || saveState === "saving" ? (
            <span className="animate-spin text-[#c4c7c5]">
              <LoaderIcon size={12} />
            </span>
          ) : (
            <CheckIcon className="size-3.5 text-[#9aa0a6]" />
          )}
          <span>{saveLabel}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <CanvasHeaderIconButton label={saveLabel}>
          <CloudIcon className="size-4" />
        </CanvasHeaderIconButton>
        <CanvasHeaderIconButton
          disabled={currentVersionIndex <= 0}
          label="上一版本"
          onClick={() => handleVersionChange("prev")}
        >
          <Undo2Icon className="size-4" />
        </CanvasHeaderIconButton>
        <CanvasHeaderIconButton
          disabled={isCurrentVersion}
          label="下一版本"
          onClick={() => handleVersionChange("next")}
        >
          <Redo2Icon className="size-4" />
        </CanvasHeaderIconButton>
        <CanvasHeaderIconButton
          disabled={!copyContent.trim()}
          label="复制"
          onClick={() => {
            navigator.clipboard.writeText(copyContent);
            toast.success("已复制到剪贴板");
          }}
        >
          <CopyIcon className="size-4" />
        </CanvasHeaderIconButton>
        <button
          className="ml-1 hidden h-8 items-center gap-1.5 rounded-full bg-[#e8eaed] px-3 text-[13px] font-medium text-[#202124] transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40 md:flex"
          disabled={!copyContent.trim()}
          onClick={async () => {
            await downloadApiFile(exportEndpoint, exportFilename);
            toast.success(isPrototype ? "已开始下载 HTML" : "已开始下载 Word");
          }}
          type="button"
        >
          <DownloadIcon className="size-4" />
          导出
        </button>
        <CanvasHeaderIconButton label="更多">
          <MoreVerticalIcon className="size-4" />
        </CanvasHeaderIconButton>
      </div>
    </div>
  );
}

function WorkbenchCanvasSideTools({
  artifact,
  artifactDefinition,
  chatId,
  consoleError,
  currentVersionIndex,
  handleVersionChange,
  isCurrentVersion,
  metadata,
  mode,
  selectedText,
  sendMessage,
  setMetadata,
}: {
  artifact: UIArtifact;
  artifactDefinition: (typeof artifactDefinitions)[number];
  chatId: string;
  consoleError?: string;
  currentVersionIndex: number;
  handleVersionChange: (type: "next" | "prev" | "toggle" | "latest") => void;
  isCurrentVersion: boolean;
  metadata: any;
  mode: "edit" | "diff";
  selectedText?: string;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  setMetadata: ArtifactActionContext["setMetadata"];
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const actionContext: ArtifactActionContext = {
    content: artifact.content,
    conversationId: chatId,
    documentId: artifact.documentId,
    kind: artifact.kind,
    handleVersionChange,
    currentVersionIndex,
    isCurrentVersion,
    mode,
    metadata,
    setMetadata,
  };
  const toolbarContext: ArtifactToolbarContext = {
    content: artifact.content,
    documentId: artifact.documentId,
    metadata,
    selectedText,
    sendMessage,
  };
  const isBusy = artifact.status === "streaming";

  return (
    <div
      aria-label="Canvas 工具"
      className="absolute top-4 right-3 z-20 hidden flex-col items-center gap-1 rounded-full border border-white/10 bg-[#171819]/95 p-1.5 shadow-[0_18px_44px_-24px_rgba(0,0,0,0.9)] backdrop-blur-xl md:flex"
    >
      {artifactDefinition.toolbar.map((tool) => (
        <WorkbenchCanvasToolButton
          disabled={isBusy}
          key={tool.description}
          label={tool.description}
          onClick={() => tool.onClick(toolbarContext)}
        >
          {tool.icon}
        </WorkbenchCanvasToolButton>
      ))}

      {artifactDefinition.actions.length > 0 ? (
        <div className="my-1 h-px w-5 bg-white/10" />
      ) : null}

      {artifactDefinition.actions.map((action) => {
        const disabled =
          isBusy ||
          (action.isDisabled ? action.isDisabled(actionContext) : false);
        return (
          <WorkbenchCanvasToolButton
            disabled={disabled || pendingAction === action.description}
            key={action.description}
            label={action.description}
            onClick={async () => {
              setPendingAction(action.description);
              try {
                await Promise.resolve(action.onClick(actionContext));
              } catch {
                toast.error("操作执行失败");
              } finally {
                setPendingAction(null);
              }
            }}
          >
            {pendingAction === action.description ? (
              <span className="animate-spin">
                <LoaderIcon size={16} />
              </span>
            ) : (
              action.icon
            )}
          </WorkbenchCanvasToolButton>
        );
      })}

      {consoleError ? (
        <>
          <div className="my-1 h-px w-5 bg-white/10" />
          <WorkbenchCanvasToolButton
            disabled={isBusy}
            label="修复错误"
            onClick={() => {
              sendMessage({
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: `请修复当前画布中的错误，不要创建新的产物。\n\n${consoleError}`,
                  },
                ],
              });
            }}
          >
            <Code2Icon className="size-4" />
          </WorkbenchCanvasToolButton>
        </>
      ) : null}
    </div>
  );
}

function WorkbenchCanvasToolButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-full text-[#c4c7c5] transition-all hover:bg-white/[0.08] hover:text-[#e8eaed] active:scale-95 disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function CanvasHeaderIconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-full text-[#c4c7c5] transition-colors hover:bg-white/[0.08] hover:text-[#e8eaed] disabled:pointer-events-none disabled:opacity-35"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function stripPrototypePreviewPrefix(content: string) {
  const previewPrefix = "preview:";
  return content.startsWith(previewPrefix)
    ? content.slice(previewPrefix.length)
    : content;
}

export const Artifact = memo(PureArtifact, (prevProps, nextProps) => {
  if (prevProps.status !== nextProps.status) {
    return false;
  }
  if (!equal(prevProps.votes, nextProps.votes)) {
    return false;
  }
  if (prevProps.input !== nextProps.input) {
    return false;
  }
  if (prevProps.messages.length !== nextProps.messages.length) {
    return false;
  }
  if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
    return false;
  }

  return true;
});
