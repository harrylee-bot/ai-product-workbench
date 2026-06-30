import { toast } from "sonner";
import { Artifact } from "@/components/chat/create-artifact";
import { CopyIcon } from "@/components/chat/icons";

type Metadata = Record<string, never>;

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
  content: ({ content }) => {
    return (
      <iframe
        title="原型预览"
        sandbox="allow-scripts"
        srcDoc={content}
        className="h-full w-full border-0 bg-white"
      />
    );
  },
  actions: [
    {
      icon: <CopyIcon size={18} />,
      description: "复制 HTML 到剪贴板",
      onClick: ({ content }) => {
        navigator.clipboard.writeText(content);
        toast.success("已复制到剪贴板");
      },
    },
  ],
  toolbar: [],
});
