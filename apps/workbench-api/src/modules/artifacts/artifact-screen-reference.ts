import { prototypeDocumentSchema } from "@workbench/workbench-contracts";

type ScreenSelectableArtifactVersion = {
  content: unknown;
  contentBlobId: string | null;
  artifact: { kind: string };
};

export function artifactVersionScreenIds(
  version: ScreenSelectableArtifactVersion,
): ReadonlySet<string> | null {
  if (version.artifact.kind !== "prototype" || version.contentBlobId !== null) return null;
  const document = prototypeDocumentSchema.safeParse(version.content);
  if (!document.success) return null;
  return new Set(document.data.screens.map((screen) => screen.id));
}
