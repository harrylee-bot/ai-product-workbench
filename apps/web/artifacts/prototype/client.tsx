import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Artifact } from "@/components/chat/create-artifact";
import { CopyIcon } from "@/components/chat/icons";

type Metadata = Record<string, never>;
const PREVIEW_PREFIX = "preview:";

export const prototypeArtifact = new Artifact<"prototype", Metadata>({
  kind: "prototype",
  description: "适用于生成原型 HTML；以沙箱 iframe 渲染预览。",
  onStreamPart: ({ streamPart, setArtifact }) => {
    if (streamPart.type === "data-codeDelta") {
      setArtifact((draftArtifact) => ({
        ...draftArtifact,
        content: streamPart.data,
        isVisible: true,
        status: "streaming",
      }));
    }
  },
  content: ({ content }) => <PrototypeFrame content={content} />,
  actions: [
    {
      icon: <CopyIcon size={18} />,
      description: "复制预览地址或 HTML 到剪贴板",
      onClick: ({ content }) => {
        navigator.clipboard.writeText(
          content.startsWith(PREVIEW_PREFIX) ? content.slice(PREVIEW_PREFIX.length) : content,
        );
        toast.success("已复制到剪贴板");
      },
    },
  ],
  toolbar: [],
});

function PrototypeFrame({ content }: { content: string }) {
  const [blobUrl, setBlobUrl] = useState<string>();
  const isPreviewUrl = content.startsWith(PREVIEW_PREFIX);
  const previewUrl = isPreviewUrl ? content.slice(PREVIEW_PREFIX.length) : "";

  useEffect(() => {
    if (isPreviewUrl || !content.trim()) {
      setBlobUrl(undefined);
      return;
    }

    const url = URL.createObjectURL(
      new Blob([content], { type: "text/html;charset=utf-8" }),
    );
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [content, isPreviewUrl]);

  const src = previewUrl || blobUrl;
  if (!src) {
    return <div className="h-full w-full bg-white" />;
  }

  return (
    <iframe
      title="原型预览"
      sandbox="allow-scripts"
      src={src}
      className="h-full w-full border-0 bg-white"
    />
  );
}
