import {
  runArtifactTargetsSchema,
  type RunArtifactTarget,
} from "@workbench/workbench-contracts";

type ArtifactTargetReference = {
  artifactId: string;
  artifactVersionId: string;
  screenId?: string;
};

export function toRunArtifactTargets(
  references: readonly ArtifactTargetReference[],
): RunArtifactTarget[] {
  const targets = new Map<string, RunArtifactTarget>();
  for (const reference of references) {
    const existing = targets.get(reference.artifactVersionId);
    if (existing) {
      if (existing.artifactId !== reference.artifactId) {
        throw new Error("An ArtifactVersion target cannot belong to multiple Artifacts");
      }
      if (existing.screenIds.length === 0 || reference.screenId === undefined) {
        existing.screenIds = [];
      } else if (!existing.screenIds.includes(reference.screenId)) {
        existing.screenIds.push(reference.screenId);
      }
      continue;
    }
    targets.set(reference.artifactVersionId, {
      artifactId: reference.artifactId,
      artifactVersionId: reference.artifactVersionId,
      screenIds: reference.screenId === undefined ? [] : [reference.screenId],
    });
  }
  return [...targets.values()];
}

export function isValidEditArtifactTargets(
  targets: readonly RunArtifactTarget[],
): boolean {
  return targets.length > 0 && runArtifactTargetsSchema.safeParse(targets).success;
}
