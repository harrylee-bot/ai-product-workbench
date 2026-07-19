import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchIdentityApi } from "./index";

const unpersisted = {
  productUpdatesEmail: false,
  researchInvitations: false,
  revision: 0,
  createdAt: null,
  updatedAt: null,
};

describe("Identity API contracts", () => {
  it("strictly validates the authenticated principal", async () => {
    const principal = {
      id: "principal-1",
      issuer: "https://auth.example.test",
      subject: "user-1",
      email: "owner@example.test",
      displayName: "Owner",
      defaultWorkspaceId: "workspace-1",
    };
    const responses = [principal, { ...principal, internalRole: "admin" }];
    const api = new WorkbenchIdentityApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch: vi.fn(async (request) => {
        expect(request.url).toBe("http://workbench.test/api/v1/identity/me");
        return Response.json(responses.shift());
      }),
    }));

    await expect(api.getIdentity()).resolves.toEqual(principal);
    await expect(api.getIdentity()).rejects.toBeInstanceOf(WorkbenchContractError);
  });

  it("uses the authenticated BFF resource and preserves the revision ETag", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.method === "GET") {
        return Response.json(unpersisted, { headers: { ETag: '"0"' } });
      }
      return Response.json({
        ...unpersisted,
        productUpdatesEmail: true,
        revision: 1,
        createdAt: "2026-07-14T08:30:00.000Z",
        updatedAt: "2026-07-14T08:30:00.000Z",
      }, { headers: { ETag: '"1"' } });
    });
    const api = new WorkbenchIdentityApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.getCommunicationPreferences()).resolves.toEqual({
      value: unpersisted,
      etag: '"0"',
    });
    await expect(api.updateCommunicationPreferences({
      productUpdatesEmail: true,
      researchInvitations: false,
    }, '"0"')).resolves.toMatchObject({
      value: { productUpdatesEmail: true, revision: 1 },
      etag: '"1"',
    });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "http://workbench.test/api/v1/identity/preferences"],
      ["PUT", "http://workbench.test/api/v1/identity/preferences"],
    ]);
    expect(requests[1]?.headers.get("if-match")).toBe('"0"');
    await expect(requests[1]?.json()).resolves.toEqual({
      productUpdatesEmail: true,
      researchInvitations: false,
    });
  });
});
