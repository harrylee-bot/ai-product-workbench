"use client";

import type { DataUIPart } from "ai";
import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { initialArtifactData, useArtifact } from "@/hooks/use-artifact";
import type { CustomUIDataTypes } from "@/lib/types";
import { artifactDefinitions, type ArtifactKind } from "./artifact";
import { useDataStream } from "./data-stream-provider";
import { CHAT_HISTORY_KEY } from "./sidebar-history";

export function DataStreamHandler() {
  const { dataStream, setDataStream } = useDataStream();
  const { mutate } = useSWRConfig();

  const { artifact, setArtifact, setMetadata } = useArtifact();

  useEffect(() => {
    if (!dataStream?.length) {
      return;
    }

    const newDeltas = dataStream.slice();
    setDataStream([]);

    let currentArtifactKind = artifact.kind;

    for (const delta of newDeltas) {
      if (delta.type === "data-chat-title") {
        mutate(CHAT_HISTORY_KEY);
        continue;
      }

      currentArtifactKind = kindForStreamPart(delta, currentArtifactKind);
      const artifactDefinition = artifactDefinitions.find(
        (currentArtifactDefinition) =>
          currentArtifactDefinition.kind === currentArtifactKind
      );

      if (artifactDefinition?.onStreamPart) {
        artifactDefinition.onStreamPart({
          streamPart: delta,
          setArtifact,
          setMetadata,
        });
      }

      setArtifact((draftArtifact) => {
        if (!draftArtifact) {
          return { ...initialArtifactData, status: "streaming" };
        }

        switch (delta.type) {
          case "data-id":
            return {
              ...draftArtifact,
              documentId: delta.data,
              status: "streaming",
            };

          case "data-title":
            return {
              ...draftArtifact,
              title: delta.data,
              status: "streaming",
            };

          case "data-kind":
            return {
              ...draftArtifact,
              kind: isArtifactKind(delta.data) ? delta.data : draftArtifact.kind,
              isVisible: true,
              status: "streaming",
            };

          case "data-clear":
            return {
              ...draftArtifact,
              content: "",
              status: "streaming",
            };

          case "data-finish":
            return {
              ...draftArtifact,
              status: "idle",
            };

          default:
            return draftArtifact;
        }
      });
    }
  }, [dataStream, setArtifact, setMetadata, artifact, setDataStream, mutate]);

  return null;
}

function kindForStreamPart(
  delta: DataUIPart<CustomUIDataTypes>,
  fallback: ArtifactKind,
): ArtifactKind {
  switch (delta.type) {
    case "data-kind":
      return isArtifactKind(delta.data) ? delta.data : fallback;
    case "data-codeDelta":
      return "code";
    case "data-imageDelta":
      return "image";
    case "data-sheetDelta":
      return "sheet";
    case "data-textDelta":
      return "text";
    default:
      return fallback;
  }
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return artifactDefinitions.some((definition) => definition.kind === value);
}
