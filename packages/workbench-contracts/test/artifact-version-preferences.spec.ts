import {
  artifactVersionFavoriteListItemSchema,
  artifactVersionFavoriteListSchema,
  artifactVersionPreferenceSchema,
  artifactVersionPreferenceTargetQuerySchema,
  updateArtifactVersionPreferenceRequestSchema,
  workbenchHttpRoutes,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("ArtifactVersion preference contracts", () => {
  const timestamp = "2026-07-14T08:20:00.000Z";

  it("represents a missing row as a timestamp-free revision 0 default", () => {
    expect(artifactVersionPreferenceSchema.parse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: "screen_home",
      favorite: false,
      reaction: null,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    })).toMatchObject({ revision: 0, favorite: false, reaction: null });

    expect(artifactVersionPreferenceSchema.safeParse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: "screen_home",
      favorite: false,
      reaction: null,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).success).toBe(false);
  });

  it("requires persisted preferences to carry timestamps", () => {
    expect(artifactVersionPreferenceSchema.safeParse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: null,
      favorite: true,
      reaction: "like",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).success).toBe(true);

    expect(artifactVersionPreferenceSchema.safeParse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: null,
      favorite: true,
      reaction: "like",
      revision: 1,
      createdAt: null,
      updatedAt: null,
    }).success).toBe(false);
    expect(artifactVersionPreferenceSchema.safeParse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: null,
      favorite: true,
      reaction: "like",
      revision: 1,
      createdAt: timestamp,
      updatedAt: null,
    }).success).toBe(false);
  });

  it("models reaction as one mutually-exclusive value and rejects extra fields", () => {
    for (const reaction of ["like", "dislike", null] as const) {
      expect(updateArtifactVersionPreferenceRequestSchema.parse({
        favorite: true,
        reaction,
      })).toEqual({ favorite: true, reaction });
    }

    expect(updateArtifactVersionPreferenceRequestSchema.safeParse({
      favorite: true,
      reaction: "love",
    }).success).toBe(false);
    expect(updateArtifactVersionPreferenceRequestSchema.safeParse({
      favorite: true,
      reaction: "like",
      principalId: "principal_2",
    }).success).toBe(false);
  });

  it("accepts only a non-empty opaque screen target when supplied", () => {
    expect(artifactVersionPreferenceTargetQuerySchema.parse({})).toEqual({});
    expect(artifactVersionPreferenceTargetQuerySchema.parse({ screenId: "screen_home" }))
      .toEqual({ screenId: "screen_home" });
    expect(artifactVersionPreferenceTargetQuerySchema.safeParse({ screenId: "" }).success)
      .toBe(false);
  });

  it("models a project favourite as display metadata for one immutable target", () => {
    expect(artifactVersionFavoriteListItemSchema.parse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      artifactKind: "prototype",
      artifactTitle: "Procurement portal",
      artifactVersion: 3,
      screenId: "screen_home",
      screenName: "Home",
      updatedAt: timestamp,
    })).toMatchObject({
      artifactKind: "prototype",
      artifactVersion: 3,
      screenName: "Home",
    });

    expect(artifactVersionFavoriteListItemSchema.safeParse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      artifactKind: "prototype",
      artifactTitle: "Procurement portal",
      artifactVersion: 3,
      screenId: null,
      screenName: null,
      updatedAt: timestamp,
    }).success).toBe(false);
    expect(artifactVersionFavoriteListItemSchema.safeParse({
      artifactId: "artifact_2",
      artifactVersionId: "version_2",
      artifactKind: "image",
      artifactTitle: "Hero",
      artifactVersion: 1,
      screenId: "forged_screen",
      screenName: "Forged",
      updatedAt: timestamp,
    }).success).toBe(false);
  });

  it("bounds a project favourite page and registers its authenticated route", () => {
    const item = artifactVersionFavoriteListItemSchema.parse({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      artifactKind: "prototype",
      artifactTitle: "Procurement portal",
      artifactVersion: 3,
      screenId: "screen_home",
      screenName: "Home",
      updatedAt: timestamp,
    });
    expect(artifactVersionFavoriteListSchema.parse({
      items: [item],
      nextCursor: "cursor_1",
    })).toEqual({ items: [item], nextCursor: "cursor_1" });
    expect(artifactVersionFavoriteListSchema.safeParse({
      items: Array.from({ length: 101 }, () => item),
      nextCursor: null,
    }).success).toBe(false);

    expect(workbenchHttpRoutes).toContainEqual(expect.objectContaining({
      method: "get",
      operationId: "listArtifactVersionFavorites",
      path: "/projects/{projectId}/artifact-version-favorites",
    }));
  });
});
