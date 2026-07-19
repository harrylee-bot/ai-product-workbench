import type { PublicProjectRelease } from "@workbench/workbench-contracts";

export type PublicSharePreviewEntry = {
  key: string;
  artifactId: string;
  artifactVersionId: string;
  kind: PublicProjectRelease["artifactPins"][number]["kind"];
  screenId?: string;
  title: string;
};

export function publicSharePreviewEntries(
  release: Pick<PublicProjectRelease, "artifactPins" | "boardSnapshot">,
): PublicSharePreviewEntry[] {
  const pinsByArtifact = new Map(
    release.artifactPins.map((pin) => [pin.artifactId, pin]),
  );
  const representedArtifactIds = new Set<string>();
  const boardEntries = release.boardSnapshot.nodes.flatMap((node) => {
    if (
      node.kind !== "artifact"
      || node.data.nodeType !== "artifact"
      || node.artifactId === null
      || node.artifactVersionId === null
    ) return [];
    const pin = pinsByArtifact.get(node.artifactId);
    if (!pin || pin.artifactVersionId !== node.artifactVersionId) return [];
    representedArtifactIds.add(pin.artifactId);
    return [{
      key: `board:${node.id}`,
      artifactId: pin.artifactId,
      artifactVersionId: pin.artifactVersionId,
      kind: pin.kind,
      ...(node.data.screenId === undefined ? {} : { screenId: node.data.screenId }),
      title: node.data.title,
    }];
  });
  const unplacedEntries = release.artifactPins.flatMap((pin) => (
    representedArtifactIds.has(pin.artifactId)
      ? []
      : [{
          key: `artifact:${pin.artifactId}`,
          artifactId: pin.artifactId,
          artifactVersionId: pin.artifactVersionId,
          kind: pin.kind,
          title: pin.title,
        }]
  ));
  return [...boardEntries, ...unplacedEntries];
}
