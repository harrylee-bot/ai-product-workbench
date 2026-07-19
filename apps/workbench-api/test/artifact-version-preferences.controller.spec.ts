import type { Response } from "express";
import { artifactVersionPreferenceEtag } from "../src/modules/artifacts/artifact-version-preference-etag.js";
import { ArtifactVersionPreferencesController } from "../src/modules/artifacts/artifact-version-preferences.controller.js";

const preference = {
  artifactId: "artifact_1",
  artifactVersionId: "version_1",
  screenId: "screen_home",
  favorite: true,
  reaction: "like" as const,
  revision: 1,
  createdAt: "2026-07-14T08:20:00.000Z",
  updatedAt: "2026-07-14T08:20:00.000Z",
};

function responseDouble() {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe("ArtifactVersionPreferencesController", () => {
  const preferenceEtag = (principalId: string, revision: number, overrides: {
    artifactId?: string;
    artifactVersionId?: string;
    screenId?: string | null;
  } = {}) => artifactVersionPreferenceEtag({
    principalId,
    artifactId: overrides.artifactId ?? "artifact_1",
    artifactVersionId: overrides.artifactVersionId ?? "version_1",
    screenId: overrides.screenId === undefined ? "screen_home" : overrides.screenId,
  }, revision);

  it("lists only the current principal's Project favourites as private data", async () => {
    const favorites = { items: [], nextCursor: null };
    const service = { listFavorites: vi.fn().mockResolvedValue(favorites) };
    const controller = new ArtifactVersionPreferencesController(service as never);
    const response = responseDouble();

    await expect(controller.listFavorites(
      { id: "principal_1" } as never,
      "project_1",
      undefined,
      "30",
      response as unknown as Response,
    )).resolves.toEqual(favorites);

    expect(service.listFavorites).toHaveBeenCalledWith(
      "principal_1",
      "project_1",
      undefined,
      30,
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("emits the principal-scoped virtual default ETag and honors If-None-Match", async () => {
    const service = {
      get: vi.fn().mockResolvedValue({
        ...preference,
        favorite: false,
        reaction: null,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      }),
    };
    const controller = new ArtifactVersionPreferencesController(service as never);
    const response = responseDouble();

    await expect(controller.get(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      { screenId: "screen_home" },
      `W/${preferenceEtag("principal_1", 0)}`,
      response as unknown as Response,
    )).resolves.toBeUndefined();

    expect(response.setHeader).toHaveBeenCalledWith(
      "ETag",
      preferenceEtag("principal_1", 0),
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-cache");
    expect(response.status).toHaveBeenCalledWith(304);
  });

  it("does not return 304 for another principal at the same revision", async () => {
    const service = { get: vi.fn().mockResolvedValue(preference) };
    const controller = new ArtifactVersionPreferencesController(service as never);
    const response = responseDouble();

    await expect(controller.get(
      { id: "principal_2" } as never,
      "artifact_1",
      "version_1",
      { screenId: "screen_home" },
      preferenceEtag("principal_1", 1),
      response as unknown as Response,
    )).resolves.toEqual(preference);

    expect(preferenceEtag("principal_1", 1)).not.toBe(preferenceEtag("principal_2", 1));
    expect(response.status).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith(
      "ETag",
      preferenceEtag("principal_2", 1),
    );
  });

  it("parses If-Match, delegates only the current principal, and emits the new ETag", async () => {
    const service = { update: vi.fn().mockResolvedValue(preference) };
    const controller = new ArtifactVersionPreferencesController(service as never);
    const response = responseDouble();
    const body = { favorite: true, reaction: "like" as const };

    await expect(controller.update(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      { screenId: "screen_home" },
      preferenceEtag("principal_1", 0),
      body,
      response as unknown as Response,
    )).resolves.toEqual(preference);

    expect(service.update).toHaveBeenCalledWith(
      "principal_1",
      "artifact_1",
      "version_1",
      "screen_home",
      0,
      body,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "ETag",
      preferenceEtag("principal_1", 1),
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("requires a strong scoped If-Match before calling the service", async () => {
    const service = { update: vi.fn() };
    const controller = new ArtifactVersionPreferencesController(service as never);

    await expect(controller.update(
      { id: "principal_1" } as never,
      "artifact_1",
      "version_1",
      { screenId: "screen_home" },
      undefined,
      { favorite: false, reaction: null },
      responseDouble() as unknown as Response,
    )).rejects.toMatchObject({ status: 428 });
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects another principal or resource scope before calling the service", async () => {
    const service = { update: vi.fn() };
    const controller = new ArtifactVersionPreferencesController(service as never);
    const body = { favorite: false, reaction: null };

    for (const ifMatch of [
      preferenceEtag("principal_2", 1),
      preferenceEtag("principal_1", 1, { artifactVersionId: "version_2" }),
      preferenceEtag("principal_1", 1, { screenId: "screen_other" }),
    ]) {
      await expect(controller.update(
        { id: "principal_1" } as never,
        "artifact_1",
        "version_1",
        { screenId: "screen_home" },
        ifMatch,
        body,
        responseDouble() as unknown as Response,
      )).rejects.toMatchObject({ status: 412 });
    }
    expect(service.update).not.toHaveBeenCalled();
  });
});
