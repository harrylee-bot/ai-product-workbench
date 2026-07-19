import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchProjectsApi } from "./index";

const member = {
  principalId: "principal-2",
  role: "member" as const,
  displayName: "Product Owner",
  email: "owner@example.com",
};

describe("Projects API Workspace member contracts", () => {
  it("sends search pagination filters and validates the returned cursor page", async () => {
    const responses = [
      { items: [member], nextCursor: "cursor-2" },
      { items: [member], nextCursor: null, privateSubject: "forbidden" },
    ];
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/workspaces/workspace-1/members");
      expect(url.searchParams.get("q")).toBe("owner@example.com");
      expect(url.searchParams.get("cursor")).toBe("cursor-1");
      expect(url.searchParams.get("limit")).toBe("20");
      return Response.json(responses.shift());
    });
    const api = new WorkbenchProjectsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    const options = { q: "owner@example.com", cursor: "cursor-1", limit: 20 };
    await expect(api.listWorkspaceMembers("workspace-1", options))
      .resolves.toEqual({ items: [member], nextCursor: "cursor-2" });
    await expect(api.listWorkspaceMembers("workspace-1", options))
      .rejects.toBeInstanceOf(WorkbenchContractError);
  });
});
