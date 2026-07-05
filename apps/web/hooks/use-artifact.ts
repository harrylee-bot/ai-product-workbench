"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import type { UIArtifact } from "@/components/chat/artifact";
import { getDocumentsById } from "@/lib/api/nest-client";

export const initialArtifactData: UIArtifact = {
  documentId: "init",
  content: "",
  kind: "text",
  title: "",
  status: "idle",
  isVisible: false,
  boundingBox: {
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  },
};

type Selector<T> = (state: UIArtifact) => T;

export function useArtifactSelector<Selected>(selector: Selector<Selected>) {
  const { data: localArtifact } = useSWR<UIArtifact>("artifact", null, {
    fallbackData: initialArtifactData,
  });

  const selectedValue = useMemo(() => {
    if (!localArtifact) {
      return selector(initialArtifactData);
    }
    return selector(localArtifact);
  }, [localArtifact, selector]);

  return selectedValue;
}

export function useArtifact() {
  const { data: localArtifact, mutate: setLocalArtifact } = useSWR<UIArtifact>(
    "artifact",
    null,
    {
      fallbackData: initialArtifactData,
    }
  );

  const artifact = useMemo(() => {
    if (!localArtifact) {
      return initialArtifactData;
    }
    return localArtifact;
  }, [localArtifact]);

  const setArtifact = useCallback(
    (updaterFn: UIArtifact | ((currentArtifact: UIArtifact) => UIArtifact)) => {
      setLocalArtifact((currentArtifact) => {
        const artifactToUpdate = currentArtifact || initialArtifactData;

        if (typeof updaterFn === "function") {
          return updaterFn(artifactToUpdate);
        }

        return updaterFn;
      });
    },
    [setLocalArtifact]
  );

  // On page refresh the in-memory SWR cache is lost and content is "".
  // Re-fetch the document from the backend whenever we have a documentId but no content.
  useSWR(
    artifact.documentId && artifact.documentId !== "init" && !artifact.content
      ? `artifact-content-${artifact.kind}-${artifact.documentId}`
      : null,
    () => getDocumentsById(artifact.documentId, artifact.kind),
    {
      onSuccess: (docs) => {
        const doc = docs?.[0];
        if (doc?.content) {
          setLocalArtifact((current) => {
            const base = current || initialArtifactData;
            // Only patch if content is still empty to avoid overwriting a live stream
            if (base.content) return base;
            return { ...base, content: doc.content ?? "", title: doc.title || base.title };
          });
        }
      },
      revalidateOnFocus: false,
    }
  );

  const { data: localArtifactMetadata, mutate: setLocalArtifactMetadata } =
    useSWR<any>(
      () =>
        artifact.documentId ? `artifact-metadata-${artifact.documentId}` : null,
      null,
      {
        fallbackData: null,
      }
    );

  return useMemo(
    () => ({
      artifact,
      setArtifact,
      metadata: localArtifactMetadata,
      setMetadata: setLocalArtifactMetadata,
    }),
    [artifact, setArtifact, localArtifactMetadata, setLocalArtifactMetadata]
  );
}
