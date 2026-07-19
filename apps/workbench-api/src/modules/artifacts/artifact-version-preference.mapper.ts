import {
  artifactVersionPreferenceSchema,
  type ArtifactVersionPreference,
  type ArtifactVersionReaction,
} from "@workbench/workbench-contracts";

export type StoredArtifactVersionPreference = {
  artifactId: string;
  artifactVersionId: string;
  screenId: string;
  favorite: boolean;
  reaction: ArtifactVersionReaction | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export function mapArtifactVersionPreference(
  preference: StoredArtifactVersionPreference,
): ArtifactVersionPreference {
  return artifactVersionPreferenceSchema.parse({
    artifactId: preference.artifactId,
    artifactVersionId: preference.artifactVersionId,
    screenId: preference.screenId || null,
    favorite: preference.favorite,
    reaction: preference.reaction,
    revision: preference.revision,
    createdAt: preference.createdAt.toISOString(),
    updatedAt: preference.updatedAt.toISOString(),
  });
}

export function defaultArtifactVersionPreference(
  artifactId: string,
  artifactVersionId: string,
  screenId: string | null,
): ArtifactVersionPreference {
  return artifactVersionPreferenceSchema.parse({
    artifactId,
    artifactVersionId,
    screenId,
    favorite: false,
    reaction: null,
    revision: 0,
    createdAt: null,
    updatedAt: null,
  });
}
