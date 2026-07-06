"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import {
  ArrowUpIcon,
  BookOpenIcon,
  CloudIcon,
  FileTextIcon,
  GraduationCapIcon,
  ImageIcon,
  InfoIcon,
  MusicIcon,
  PlusIcon,
  SparklesIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useLocalStorage, useWindowSize } from "usehooks-ts";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { useArtifact } from "@/hooks/use-artifact";
import type { ChatArtifactMode } from "@/hooks/use-active-chat";
import type { Attachment, ChatMessage } from "@/lib/types";
import {
  type ChatRuntimeModel,
  deleteAllChats,
  deleteChat,
} from "@/lib/api/nest-client";
import { getApiBase } from "@/lib/api/config";
import { createChatHref, createNewChatHref } from "@/lib/chat-navigation";
import { cn } from "@/lib/utils";

import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { MoreHorizontalIcon, PaperclipIcon, StopIcon } from "./icons";
import { PreviewAttachment } from "./preview-attachment";
import {
  type SlashCommand,
  SlashCommandMenu,
  slashCommands,
} from "./slash-commands";
import { SuggestedActions } from "./suggested-actions";
import type { VisibilityType } from "./visibility-selector";

function setCookie(name: string, value: string) {
  const maxAge = 60 * 60 * 24 * 365;
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`;
}

function PureMultimodalInput({
  chatId,
  input,
  setInput,
  status,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  className,
  selectedVisibilityType,
  selectedModelId,
  selectedArtifactMode,
  onArtifactModeChange,
  onModelChange,
  runtimeModel,
  editingMessage,
  onCancelEdit,
  isLoading,
}: {
  chatId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
  selectedArtifactMode: ChatArtifactMode;
  onArtifactModeChange?: (mode: ChatArtifactMode) => void;
  onModelChange?: (modelId: string) => void;
  runtimeModel: ChatRuntimeModel;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const { setArtifact } = useArtifact();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    "input",
    ""
  );

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
    }
  }, [localStorageInput, setInput]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = event.target.value;
    setInput(val);

    if (val.startsWith("/") && !val.includes(" ")) {
      setSlashOpen(true);
      setSlashQuery(val.slice(1));
      setSlashIndex(0);
    } else {
      setSlashOpen(false);
    }
  };

  const handleSlashSelect = (cmd: SlashCommand) => {
    setSlashOpen(false);
    setInput("");
    switch (cmd.action) {
      case "new":
        router.push(createNewChatHref());
        break;
      case "clear":
        setMessages(() => []);
        break;
      case "rename":
        toast("可在左侧对话菜单中重命名。");
        break;
      case "model": {
        const modelBtn = document.querySelector<HTMLButtonElement>(
          "[data-testid='model-selector']"
        );
        modelBtn?.click();
        break;
      }
      case "theme":
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
        break;
      case "delete":
        toast("删除当前对话？", {
          action: {
            label: "删除",
            onClick: async () => {
              try {
                await deleteChat(chatId);
                router.push(createNewChatHref());
                toast.success("对话已删除");
              } catch {
                toast.error("删除对话失败");
              }
            },
          },
        });
        break;
      case "purge":
        toast("删除全部对话？", {
          action: {
            label: "删除全部",
            onClick: async () => {
              try {
                await deleteAllChats();
                router.push(createNewChatHref());
                toast.success("已删除全部对话");
              } catch {
                toast.error("删除全部对话失败");
              }
            },
          },
        });
        break;
      default:
        break;
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const isGenerating = status === "submitted" || status === "streaming";
  const isCanvasMode = selectedArtifactMode === "canvas";

  const submitForm = useCallback(() => {
    router.replace(createChatHref(chatId));

    if (isCanvasMode) {
      setArtifact((currentArtifact) => ({
        ...currentArtifact,
        documentId: "init",
        kind: "text",
        title: inferCanvasDraftTitle(input),
        content: "",
        status: "streaming",
        isVisible: true,
      }));
    }

    sendMessage({
      role: "user",
      parts: [
        ...attachments.map((attachment) => ({
          type: "file" as const,
          fileId: attachment.fileId,
          url: attachment.url,
          name: attachment.name,
          mediaType: attachment.contentType,
          size: attachment.size,
        })),
        {
          type: "text",
          text: input,
        },
      ],
    });

    setAttachments([]);
    setLocalStorageInput("");
    setInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [
    input,
    setInput,
    attachments,
    sendMessage,
    setAttachments,
    setLocalStorageInput,
    width,
    chatId,
    router,
    isCanvasMode,
    setArtifact,
  ]);

  const uploadFile = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("files", file);

    try {
      const response = await fetch(
        `${getApiBase()}/conversations/${chatId}/files`,
        {
          method: "POST",
          body: formData,
          credentials: "include",
        }
      );

      if (response.ok) {
        const data = await response.json();
        const item = data.items?.[0];
        if (!item) throw new Error("UPLOAD_EMPTY_RESPONSE");

        return {
          fileId: item.id,
          url: item.publicUrl ?? URL.createObjectURL(file),
          name: item.originalName ?? file.name,
          contentType: item.mimeType ?? file.type,
          size: item.size ?? file.size,
        };
      }
      const { error } = await response.json();
      toast.error(error);
    } catch {
      toast.error("文件上传失败，请重试");
    }
  }, [chatId]);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);

      setUploadQueue(files.map((file) => file.name));

      try {
        const uploadPromises = files.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);
      } catch {
        toast.error("文件上传失败");
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }

      const imageItems = Array.from(items).filter((item) =>
        item.type.startsWith("image/")
      );

      if (imageItems.length === 0) {
        return;
      }

      event.preventDefault();

      setUploadQueue((prev) => [...prev, "粘贴的图片"]);

      try {
        const uploadPromises = imageItems
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
          .map((file) => uploadFile(file));

        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) =>
            attachment !== undefined &&
            attachment.url !== undefined &&
            attachment.contentType !== undefined
        );

        setAttachments((curr) => [
          ...curr,
          ...(successfullyUploadedAttachments as Attachment[]),
        ]);
      } catch {
        toast.error("粘贴图片上传失败");
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.addEventListener("paste", handlePaste);
    return () => textarea.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {editingMessage && onCancelEdit && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>正在编辑消息</span>
          <button
            className="rounded-md px-1.5 py-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/70 hover:text-foreground"
            onMouseDown={(e) => {
              e.preventDefault();
              onCancelEdit();
            }}
            type="button"
          >
            取消
          </button>
        </div>
      )}

      {!editingMessage &&
        !isLoading &&
        messages.length === 0 &&
        attachments.length === 0 &&
        uploadQueue.length === 0 && (
          <SuggestedActions
            chatId={chatId}
            selectedVisibilityType={selectedVisibilityType}
            sendMessage={sendMessage}
          />
        )}

      <input
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        multiple
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <div className="relative">
        {slashOpen && (
          <SlashCommandMenu
            onClose={() => setSlashOpen(false)}
            onSelect={handleSlashSelect}
            query={slashQuery}
            selectedIndex={slashIndex}
          />
        )}
      </div>

      <PromptInput
        className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/80 [&>div]:bg-card/80 [&>div]:shadow-[var(--shadow-composer)] [&>div]:backdrop-blur-2xl [&>div]:transition-all [&>div]:duration-300 [&>div]:focus-within:border-foreground/20 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
        onSubmit={() => {
          if (input.startsWith("/")) {
            const query = input.slice(1).trim();
            const cmd = slashCommands.find((c) => c.name === query);
            if (cmd) {
              handleSlashSelect(cmd);
            }
            return;
          }
          if (!input.trim() && attachments.length === 0) {
            return;
          }
          if (status === "ready" || status === "error") {
            submitForm();
          } else {
            toast.error("请等待当前回复完成后再发送");
          }
        }}
      >
        {(attachments.length > 0 || uploadQueue.length > 0) && (
          <div
            className="flex w-full self-start flex-row gap-2 overflow-x-auto px-3 pt-3 no-scrollbar"
            data-testid="attachments-preview"
          >
            {attachments.map((attachment) => (
              <PreviewAttachment
                attachment={attachment}
                key={attachment.url}
                onRemove={() => {
                  setAttachments((currentAttachments) =>
                    currentAttachments.filter((a) => a.url !== attachment.url)
                  );
                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
              />
            ))}

            {uploadQueue.map((filename) => (
              <PreviewAttachment
                attachment={{
                  url: "",
                  name: filename,
                  contentType: "",
                }}
                isUploading={true}
                key={filename}
              />
            ))}
          </div>
        )}
        <PromptInputTextarea
          className={cn(
            "px-4 text-[13px] leading-relaxed placeholder:text-muted-foreground/45",
            isCanvasMode ? "min-h-24 pt-3.5 pb-1.5" : "min-h-16 py-3.5"
          )}
          data-testid="multimodal-input"
          onChange={handleInput}
          onKeyDown={(e) => {
            if (slashOpen) {
              const filtered = slashCommands.filter((cmd) =>
                cmd.name.startsWith(slashQuery.toLowerCase())
              );
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (filtered[slashIndex]) {
                  handleSlashSelect(filtered[slashIndex]);
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashOpen(false);
                return;
              }
            }
            if (e.key === "Escape" && editingMessage && onCancelEdit) {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          placeholder={
            editingMessage
              ? "编辑你的消息..."
              : isCanvasMode
                ? "一起开始创作吧"
                : "问问 Gemini"
          }
          ref={textareaRef}
          value={input}
        />
        <PromptInputFooter className="px-3 pb-3">
          <PromptInputTools>
            <UploadAndToolsMenu
              fileInputRef={fileInputRef}
              isCanvasMode={isCanvasMode}
              onCanvasModeChange={(mode) => {
                onArtifactModeChange?.(mode);
                setTimeout(() => {
                  textareaRef.current?.focus();
                }, 50);
              }}
              status={status}
            />
            {isCanvasMode && (
              <CanvasModeChip
                onRemove={() => {
                  onArtifactModeChange?.("chat");
                  setTimeout(() => {
                    textareaRef.current?.focus();
                  }, 50);
                }}
                status={status}
              />
            )}
          </PromptInputTools>

          <div className="flex min-w-0 items-center gap-1">
            <ModelSelectorCompact
              onModelChange={onModelChange}
              runtimeModel={runtimeModel}
              selectedModelId={selectedModelId}
            />

            {isGenerating ? (
              <StopButton stop={stop} />
            ) : (
              <PromptInputSubmit
                className={cn(
                  "h-7 w-7 rounded-xl transition-all duration-200",
                  input.trim()
                    ? "bg-primary text-primary-foreground shadow-[0_10px_28px_-18px_rgba(255,255,255,0.9)] hover:opacity-90 active:scale-95"
                    : "cursor-not-allowed bg-muted/70 text-muted-foreground/30"
                )}
                data-testid="send-button"
                disabled={!input.trim() || uploadQueue.length > 0}
                status={status}
                variant="secondary"
              >
                <ArrowUpIcon className="size-4" />
              </PromptInputSubmit>
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }
    if (prevProps.selectedArtifactMode !== nextProps.selectedArtifactMode) {
      return false;
    }
    if (prevProps.runtimeModel.id !== nextProps.runtimeModel.id) {
      return false;
    }
    if (prevProps.editingMessage !== nextProps.editingMessage) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.messages.length !== nextProps.messages.length) {
      return false;
    }

    return true;
  }
);

function UploadAndToolsMenu({
  fileInputRef,
  isCanvasMode,
  onCanvasModeChange,
  status,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  isCanvasMode: boolean;
  onCanvasModeChange: (mode: ChatArtifactMode) => void;
  status: UseChatHelpers<ChatMessage>["status"];
}) {
  const [open, setOpen] = useState(false);
  const disabled = status !== "ready";
  const itemClassName =
    "h-9 cursor-default rounded-xl px-3 text-[13px] text-popover-foreground/90 focus:bg-white/8 focus:text-popover-foreground";
  const iconClassName = "size-4 text-popover-foreground/75";

  const showUnsupportedToast = (label: string) => {
    toast(`${label}暂未接入，当前可用的是 Canvas。`);
  };

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={open ? "关闭上传和工具" : "上传和工具"}
          aria-pressed={open}
          className={cn(
            "h-7 w-7 rounded-full border-0 bg-transparent p-0 text-foreground/75 transition-colors hover:bg-muted/70 hover:text-foreground",
            open && "bg-muted/80 text-foreground"
          )}
          data-testid="attachments-button"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          {open ? <XIcon className="size-4" /> : <PlusIcon className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[248px] rounded-[22px] border-white/10 bg-[#202124]/95 p-2 text-[#e8eaed] shadow-[0_20px_56px_-24px_rgba(0,0,0,0.88)] backdrop-blur-2xl"
        data-testid="upload-tools-menu"
        side="top"
        sideOffset={10}
      >
        <DropdownMenuItem
          className={itemClassName}
          onSelect={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon className={iconClassName} size={16} />
          <span>上传文件</span>
          <InfoIcon className="ml-auto size-4 text-popover-foreground/65" />
        </DropdownMenuItem>
        <DropdownMenuItem
          className={itemClassName}
          onSelect={() => showUnsupportedToast("从云端硬盘添加")}
        >
          <CloudIcon className={iconClassName} />
          <span>从云端硬盘添加</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClassName}>
            <span className={iconClassName}>
              <MoreHorizontalIcon size={16} />
            </span>
            <span>更多上传选项</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-[220px] rounded-[20px] border-white/10 bg-[#202124]/95 p-2 text-[#e8eaed] shadow-[0_20px_56px_-24px_rgba(0,0,0,0.88)] backdrop-blur-2xl">
              <DropdownMenuItem
                className={itemClassName}
                onSelect={() => showUnsupportedToast("导入链接")}
              >
                <BookOpenIcon className={iconClassName} />
                <span>导入链接</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>

        <DropdownMenuSeparator className="mx-2 my-2 bg-white/10" />

        <DropdownMenuItem
          className={itemClassName}
          onSelect={() => showUnsupportedToast("制作图片")}
        >
          <ImageIcon className={iconClassName} />
          <span>制作图片</span>
          <span className="ml-auto rounded-full bg-white/12 px-2 py-0.5 text-[11px] text-popover-foreground/80">
            新
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={itemClassName}
          onSelect={() => showUnsupportedToast("制作视频")}
        >
          <VideoIcon className={iconClassName} />
          <span>制作视频</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClassName}>
            <span className={iconClassName}>
              <MoreHorizontalIcon size={16} />
            </span>
            <span>更多工具</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent
              className="w-[220px] rounded-[20px] border-white/10 bg-[#202124]/95 p-2 text-[#e8eaed] shadow-[0_20px_56px_-24px_rgba(0,0,0,0.88)] backdrop-blur-2xl"
              data-testid="more-tools-menu"
            >
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      aria-pressed={isCanvasMode}
                      className={cn(
                        itemClassName,
                        isCanvasMode && "bg-white/10 text-popover-foreground"
                      )}
                      data-testid="canvas-tool-menu-item"
                      onSelect={() => onCanvasModeChange("canvas")}
                    >
                      <FileTextIcon className={iconClassName} />
                      <span>Canvas</span>
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent
                    className="max-w-[220px] rounded-xl bg-[#f1f3f4] px-3 py-2 text-[12px] leading-snug text-[#202124]"
                    side="right"
                    sideOffset={12}
                  >
                    编写代码、撰写内容或制作幻灯片
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <DropdownMenuItem
                className={itemClassName}
                onSelect={() => showUnsupportedToast("Deep Research")}
              >
                <SparklesIcon className={iconClassName} />
                <span>Deep Research</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className={itemClassName}
                onSelect={() => showUnsupportedToast("制作音乐")}
              >
                <MusicIcon className={iconClassName} />
                <span>制作音乐</span>
                <span className="ml-auto rounded-full bg-white/12 px-2 py-0.5 text-[11px] text-popover-foreground/80">
                  新
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className={itemClassName}
                onSelect={() => showUnsupportedToast("学习辅导")}
              >
                <GraduationCapIcon className={iconClassName} />
                <span>学习辅导</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className={itemClassName}
                onSelect={() => showUnsupportedToast("个性化智能服务")}
              >
                <SparklesIcon className={iconClassName} />
                <span className="min-w-0 flex-1 truncate">个性化智能服务</span>
                <span className="rounded-full bg-primary/80 px-1.5 py-0.5 text-[10px] text-primary-foreground">
                  Labs
                </span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CanvasModeChip({
  onRemove,
  status,
}: {
  onRemove: () => void;
  status: UseChatHelpers<ChatMessage>["status"];
}) {
  return (
    <Button
      aria-label="取消选择“Canvas”"
      className="h-7 gap-1 rounded-full border-0 bg-muted/80 px-2 text-[12px] font-medium text-foreground/90 transition-colors hover:bg-muted hover:text-foreground"
      data-testid="canvas-mode-chip"
      disabled={status !== "ready"}
      onClick={(event) => {
        event.preventDefault();
        onRemove();
      }}
      type="button"
      variant="ghost"
    >
      <FileTextIcon className="size-3.5" />
      <span>Canvas</span>
    </Button>
  );
}

function PureModelSelectorCompact({
  selectedModelId,
  onModelChange,
  runtimeModel,
}: {
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  runtimeModel: ChatRuntimeModel;
}) {
  const [open, setOpen] = useState(false);
  const activeModels = [runtimeModel];

  const selectedModel =
    activeModels.find((m) => m.id === selectedModelId) ??
    activeModels[0];
  const [provider] = selectedModel.id.split("/");

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          aria-label={`当前模型：${selectedModel.name}，点击切换模型`}
          className="h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:bg-input/40 hover:text-foreground"
          data-testid="model-selector"
          variant="ghost"
        >
          {provider && <ModelSelectorLogo provider={provider} />}
          <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="搜索模型..." />
        <ModelSelectorList>
          {(() => {
            const grouped: Record<
              string,
              { model: ChatRuntimeModel; curated: boolean }[]
            > = {};
            for (const model of activeModels) {
              const key = "_available";
              if (!grouped[key]) {
                grouped[key] = [];
              }
              grouped[key].push({ model, curated: true });
            }

            const sortedKeys = Object.keys(grouped).sort((a, b) => {
              if (a === "_available") {
                return -1;
              }
              if (b === "_available") {
                return 1;
              }
              return a.localeCompare(b);
            });

            return sortedKeys.map((key) => (
              <ModelSelectorGroup
                heading={key === "_available" ? "可用模型" : key}
                key={key}
              >
                {grouped[key].map(({ model }) => {
                  const logoProvider = model.id.split("/")[0];
                  return (
                    <ModelSelectorItem
                      className={cn(
                        "flex w-full",
                        model.id === selectedModel.id &&
                          "border-b border-dashed border-foreground/50"
                      )}
                      key={model.id}
                      onSelect={() => {
                        onModelChange?.(model.id);
                        setCookie("chat-model", model.id);
                        setOpen(false);
                        setTimeout(() => {
                          document
                            .querySelector<HTMLTextAreaElement>(
                              "[data-testid='multimodal-input']"
                            )
                            ?.focus();
                        }, 50);
                      }}
                      value={model.id}
                    >
                      <ModelSelectorLogo provider={logoProvider} />
                      <ModelSelectorName>{model.name}</ModelSelectorName>
                    </ModelSelectorItem>
                  );
                })}
              </ModelSelectorGroup>
            ));
          })()}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const ModelSelectorCompact = memo(PureModelSelectorCompact);

function PureStopButton({
  stop,
}: {
  stop: () => void;
}) {
  return (
    <Button
      className="h-7 w-7 rounded-xl bg-foreground p-1 text-background transition-all duration-200 hover:opacity-85 active:scale-95 disabled:bg-muted disabled:text-muted-foreground/25 disabled:cursor-not-allowed"
      data-testid="stop-button"
      onClick={(event) => {
        event.preventDefault();
        stop();
      }}
    >
      <StopIcon size={14} />
    </Button>
  );
}

const StopButton = memo(PureStopButton);

function inferCanvasDraftTitle(input: string) {
  const firstLine = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "生成中的文档";

  const cleaned = firstLine
    .replace(/^(请|帮我|给我|生成|创建|新建|写|撰写|编写|起草|输出|制定|整理)+/g, "")
    .replace(/(需求文档|需求说明书|产品需求文档|PRD|prd|文档)$/g, "")
    .replace(/[，。,.;；:：!?？]+$/g, "")
    .trim();

  const subject = cleaned || firstLine;
  return `${subject.slice(0, 28)}${subject.length > 28 ? "..." : ""}需求说明书`;
}
