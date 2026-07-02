import dynamic from "next/dynamic";
import { parse, unparse } from "papaparse";
import { toast } from "sonner";
import { Artifact } from "@/components/chat/create-artifact";
import {
  CopyIcon,
  LineChartIcon,
  RedoIcon,
  SparklesIcon,
  UndoIcon,
} from "@/components/chat/icons";

const SpreadsheetEditor = dynamic(
  () => import("@/components/chat/sheet-editor").then((module) => module.SpreadsheetEditor),
  {
    loading: () => <div className="h-full min-h-[320px] w-full animate-pulse bg-muted/30" />,
  }
);

type Metadata = Record<string, never>;

export const sheetArtifact = new Artifact<"sheet", Metadata>({
  kind: "sheet",
  description: "适用于处理表格数据",
  initialize: () => null,
  onStreamPart: ({ setArtifact, streamPart }) => {
    if (streamPart.type === "data-sheetDelta") {
      setArtifact((draftArtifact) => ({
        ...draftArtifact,
        content: streamPart.data,
        isVisible: true,
        status: "streaming",
      }));
    }
  },
  content: ({ content, currentVersionIndex, onSaveContent, status }) => {
    return (
      <SpreadsheetEditor
        content={content}
        currentVersionIndex={currentVersionIndex}
        isCurrentVersion={true}
        saveContent={onSaveContent}
        status={status}
      />
    );
  },
  actions: [
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
      icon: <CopyIcon />,
      description: "复制为 .csv",
      onClick: ({ content }) => {
        const parsed = parse<string[]>(content, { skipEmptyLines: true });

        const nonEmptyRows = parsed.data.filter((row) =>
          row.some((cell) => cell.trim() !== "")
        );

        const cleanedCsv = unparse(nonEmptyRows);

        navigator.clipboard.writeText(cleanedCsv);
        toast.success("CSV 已复制到剪贴板");
      },
    },
  ],
  toolbar: [
    {
      description: "格式化并清洗数据",
      icon: <SparklesIcon />,
      onClick: ({ sendMessage }) => {
        sendMessage({
          role: "user",
          parts: [
            { type: "text", text: "请帮我格式化并清洗这份数据。" },
          ],
        });
      },
    },
    {
      description: "分析并可视化数据",
      icon: <LineChartIcon />,
      onClick: ({ sendMessage }) => {
        sendMessage({
          role: "user",
          parts: [
            {
              type: "text",
              text: "请分析这份数据，并用 Python 创建一个新的代码画布来完成可视化。",
            },
          ],
        });
      },
    },
  ],
});
