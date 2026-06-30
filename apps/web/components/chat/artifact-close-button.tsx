import { memo } from "react";
import { useArtifact } from "@/hooks/use-artifact";
import { CrossIcon } from "./icons";

function PureArtifactCloseButton() {
  const { setArtifact } = useArtifact();

  return (
    <button
      aria-label="关闭画布"
      className="group flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-all duration-150 hover:border-border hover:bg-muted hover:text-foreground active:scale-95"
      data-testid="artifact-close-button"
      onClick={() => {
        setArtifact((currentArtifact) => ({
          ...currentArtifact,
          isVisible: false,
          status: currentArtifact.status === "streaming" ? "streaming" : "idle",
        }));
      }}
      type="button"
    >
      <CrossIcon size={16} />
    </button>
  );
}

export const ArtifactCloseButton = memo(PureArtifactCloseButton, () => true);
