import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchArtifactsApi } from "./index";

const scopedEtag = (revision: number, fill = "a") => (
  `"avp1.${revision}.${fill.repeat(43)}"`
);

describe("ArtifactVersion preference API contracts", () => {
  it("lists the principal's project favourites with opaque cursor pagination", async () => {
    const page = {
      items: [{
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        artifactKind: "prototype",
        artifactTitle: "Checkout flow",
        artifactVersion: 3,
        screenId: "screen-home",
        screenName: "Home",
        updatedAt: "2026-07-14T08:20:00.000Z",
      }],
      nextCursor: "opaque-next-page",
    };
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe(
        "/api/v1/projects/project-1/artifact-version-favorites",
      );
      expect(url.searchParams.get("cursor")).toBe("opaque-page-1");
      expect(url.searchParams.get("limit")).toBe("20");
      return Response.json(page);
    });
    const api = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.listArtifactVersionFavorites("project-1", {
      cursor: "opaque-page-1",
      limit: 20,
    })).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads revision 0 and writes the complete preference with If-Match", async () => {
    const initial = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: "screen-home",
      favorite: false,
      reaction: null,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    };
    const updated = {
      ...initial,
      favorite: true,
      reaction: "dislike",
      revision: 1,
      createdAt: "2026-07-14T08:20:00.000Z",
      updatedAt: "2026-07-14T08:20:00.000Z",
    };
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/api/v1/artifacts/artifact-1/versions/version-1/preference",
      );
      expect(new URL(request.url).searchParams.get("screenId")).toBe("screen-home");
      if (request.method === "GET") {
        return Response.json(initial, { headers: { ETag: scopedEtag(0) } });
      }
      expect(request.method).toBe("PUT");
      expect(request.headers.get("if-match")).toBe(scopedEtag(0));
      expect(await request.json()).toEqual({ favorite: true, reaction: "dislike" });
      return Response.json(updated, { headers: { ETag: scopedEtag(1) } });
    });
    const api = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.getArtifactVersionPreference("artifact-1", "version-1", "screen-home"))
      .resolves.toEqual({ value: initial, etag: scopedEtag(0) });
    await expect(api.updateArtifactVersionPreference(
      "artifact-1",
      "version-1",
      { favorite: true, reaction: "dislike" },
      scopedEtag(0),
      "screen-home",
    )).resolves.toEqual({ value: updated, etag: scopedEtag(1) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses the matching cached representation for an explicit 304", async () => {
    const value = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: "screen-home",
      favorite: true,
      reaction: "like",
      revision: 2,
      createdAt: "2026-07-14T08:20:00.000Z",
      updatedAt: "2026-07-14T08:20:00.000Z",
    } as const;
    const etag = scopedEtag(2);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(value, { headers: { ETag: etag } }))
      .mockImplementationOnce(async (request: Request) => {
        expect(request.headers.get("if-none-match")).toBe(etag);
        return new Response(null, { status: 304, headers: { ETag: etag } });
      });
    const api = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    const cached = await api.getArtifactVersionPreference(
      "artifact-1",
      "version-1",
      "screen-home",
    );
    const conditional = await api.getArtifactVersionPreference(
      "artifact-1",
      "version-1",
      "screen-home",
      cached,
    );

    expect(conditional).toBe(cached);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to an unconditional GET when a cold request receives 304", async () => {
    const value = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: null,
      favorite: false,
      reaction: null,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    } as const;
    const etag = scopedEtag(0);
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return requests.length === 1
        ? new Response(null, { status: 304, headers: { ETag: etag } })
        : Response.json(value, { headers: { ETag: etag } });
    });
    const api = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.getArtifactVersionPreference(
      "artifact-1",
      "version-1",
    )).resolves.toEqual({ value, etag });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.headers.has("if-none-match"))).toBe(true);
  });

  it("does not pair a 304 with cached bytes under another ETag", async () => {
    const oldValue = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: null,
      favorite: false,
      reaction: null,
      revision: 1,
      createdAt: "2026-07-14T08:20:00.000Z",
      updatedAt: "2026-07-14T08:20:00.000Z",
    } as const;
    const newValue = {
      ...oldValue,
      favorite: true,
      revision: 2,
      updatedAt: "2026-07-14T08:21:00.000Z",
    } as const;
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      if (requests.length === 1) {
        expect(request.headers.get("if-none-match")).toBe(scopedEtag(1));
        return new Response(null, { status: 304, headers: { ETag: scopedEtag(2, "b") } });
      }
      expect(request.headers.has("if-none-match")).toBe(false);
      return Response.json(newValue, { headers: { ETag: scopedEtag(2, "b") } });
    });
    const api = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.getArtifactVersionPreference(
      "artifact-1",
      "version-1",
      null,
      { value: oldValue, etag: scopedEtag(1) },
    )).resolves.toEqual({ value: newValue, etag: scopedEtag(2, "b") });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an unscoped ETag", '"1"'],
    ["an ETag for another revision", scopedEtag(2)],
  ])("rejects a 200 preference response with %s", async (_label, etag) => {
    const value = {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: null,
      favorite: true,
      reaction: null,
      revision: 1,
      createdAt: "2026-07-14T08:20:00.000Z",
      updatedAt: "2026-07-14T08:20:00.000Z",
    } as const;
    const api = new WorkbenchArtifactsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch: vi.fn(async () => Response.json(value, { headers: { ETag: etag } })),
    }));

    await expect(api.getArtifactVersionPreference("artifact-1", "version-1"))
      .rejects.toMatchObject({ name: "WorkbenchContractError" });
  });
});
