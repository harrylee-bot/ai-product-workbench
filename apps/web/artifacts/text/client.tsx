import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Artifact } from "@/components/chat/create-artifact";
import { DocumentSkeleton } from "@/components/chat/document-skeleton";
import {
  ClockRewind,
  CopyIcon,
  MessageIcon,
  PenIcon,
  RedoIcon,
  UndoIcon,
} from "@/components/chat/icons";
import { getSuggestionsByDocumentId } from "@/lib/api/nest-client";
import type { Suggestion } from "@/lib/api/types";

const DiffView = dynamic(
  () => import("@/components/chat/diffview").then((module) => module.DiffView),
  {
    loading: () => <DocumentSkeleton artifactKind="text" />,
  }
);

const Editor = dynamic(
  () => import("@/components/chat/text-editor").then((module) => module.Editor),
  {
    loading: () => <DocumentSkeleton artifactKind="text" />,
  }
);

type TextArtifactMetadata = {
  suggestions: Suggestion[];
  selectedText?: string;
};

export const textArtifact = new Artifact<"text", TextArtifactMetadata>({
  kind: "text",
  description: "适用于 PRD、方案和其他文本内容。",
  initialize: async ({ documentId, setMetadata }) => {
    const suggestions = await getSuggestionsByDocumentId(documentId);

    setMetadata({
      suggestions,
      selectedText: "",
    });
  },
  onStreamPart: ({ streamPart, setMetadata, setArtifact }) => {
    if (streamPart.type === "data-suggestion") {
      setMetadata((metadata) => {
        return {
          suggestions: [...metadata.suggestions, streamPart.data],
        };
      });
    }

    if (streamPart.type === "data-textDelta") {
      setArtifact((draftArtifact) => {
        return {
          ...draftArtifact,
          content: draftArtifact.content + streamPart.data,
          isVisible: true,
          status: "streaming",
        };
      });
    }
  },
  content: ({
    mode,
    status,
    content,
    isCurrentVersion,
    currentVersionIndex,
    onSaveContent,
    getDocumentContentById,
    isLoading,
    metadata,
    setMetadata,
  }) => {
    if (isLoading) {
      return <DocumentSkeleton artifactKind="text" />;
    }

    if (mode === "diff") {
      const selectedContent = getDocumentContentById(currentVersionIndex);
      const prevContent =
        currentVersionIndex > 0
          ? getDocumentContentById(currentVersionIndex - 1)
          : selectedContent;

      return (
        <div className="flex flex-row px-4 py-8 md:px-16 md:py-12 lg:px-20">
          <DiffView newContent={selectedContent} oldContent={prevContent} />
        </div>
      );
    }

    return (
      <div className="flex flex-row px-4 py-8 md:px-16 md:py-12 lg:px-20">
        <Editor
          content={content}
          currentVersionIndex={currentVersionIndex}
          isCurrentVersion={isCurrentVersion}
          onSelectionChange={(selectedText) => {
            setMetadata((currentMetadata) => ({
              suggestions: currentMetadata?.suggestions ?? [],
              selectedText,
            }));
          }}
          onSaveContent={onSaveContent}
          status={status}
          suggestions={isCurrentVersion && metadata ? metadata.suggestions : []}
        />

        {metadata?.suggestions && metadata.suggestions.length > 0 ? (
          <div className="h-dvh w-12 shrink-0 md:hidden" />
        ) : null}
      </div>
    );
  },
  actions: [
    {
      icon: <ClockRewind size={18} />,
      description: "查看变更",
      onClick: ({ handleVersionChange }) => {
        handleVersionChange("toggle");
      },
      isDisabled: ({ currentVersionIndex }) => {
        if (currentVersionIndex === 0) {
          return true;
        }

        return false;
      },
    },
    {
      icon: <UndoIcon size={18} />,
      description: "查看上一版本",
      onClick: ({ handleVersionChange }) => {
        handleVersionChange("prev");
      },
      isDisabled: ({ currentVersionIndex }) => {
        if (currentVersionIndex === 0) {
          return true;
        }

        return false;
      },
    },
    {
      icon: <RedoIcon size={18} />,
      description: "查看下一版本",
      onClick: ({ handleVersionChange }) => {
        handleVersionChange("next");
      },
      isDisabled: ({ isCurrentVersion }) => {
        if (isCurrentVersion) {
          return true;
        }

        return false;
      },
    },
    {
      icon: <CopyIcon size={18} />,
      description: "复制到剪贴板",
      onClick: ({ content }) => {
        navigator.clipboard.writeText(content);
        toast.success("已复制到剪贴板");
      },
    },
  ],
  toolbar: [
    {
      icon: <PenIcon />,
      description: "润色选区/全文",
      onClick: ({ documentId, selectedText, sendMessage }) => {
        const trimmedSelection = selectedText?.trim();
        const documentHint = documentId ? `当前画布文档 id：${documentId}\n\n` : "";

        sendMessage({
          role: "user",
          parts: [
            {
              type: "text",
              text: trimmedSelection
                ? `${documentHint}请修改现有画布，只润色我在画布中选中的这段对应内容，保持原意，不要改动其他未选中的内容。选中文本如下：\n\n${trimmedSelection}`
                : "请对这份内容做最后润色，检查语法和表达，补充更清晰的小节标题，并保证整体阅读顺畅。",
            },
          ],
        });
      },
    },
    {
      icon: <MessageIcon />,
      description: "补充选区建议",
      onClick: ({ documentId, selectedText, sendMessage }) => {
        const trimmedSelection = selectedText?.trim();
        const documentHint = documentId ? `当前画布文档 id：${documentId}\n\n` : "";

        sendMessage({
          role: "user",
          parts: [
            {
              type: "text",
              text: trimmedSelection
                ? `${documentHint}请只针对我在画布中选中的这段内容补充改进建议，不要评价其他未选中的内容。选中文本如下：\n\n${trimmedSelection}`
                : "请补充你认为能提升这份内容质量的建议。",
            },
          ],
        });
      },
    },
  ],
});
