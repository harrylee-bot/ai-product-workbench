import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "./client";
import { problemFromResponse } from "./problem-details";

describe("Workbench OpenAPI client", () => {
  it("uses the same-origin Cookie BFF without browser authorization headers", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://workbench.test/api/v1/identity/me");
      expect(request.credentials).toBe("same-origin");
      expect(request.headers.get("authorization")).toBeNull();
      return Response.json({
        id: "principal-1",
        issuer: "https://issuer.test",
        subject: "subject-1",
        email: null,
        displayName: "Tester",
        defaultWorkspaceId: "workspace-1",
      });
    });
    const client = createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1/",
      fetch,
    });

    const result = await client.GET("/identity/me");

    expect(result.data?.id).toBe("principal-1");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("throws a structured RFC 9457 error before consumers can ignore it", async () => {
    const client = createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch: async () => new Response(JSON.stringify({
        type: "https://workbench.test/problems/unauthorized",
        title: "Unauthorized",
        status: 401,
        code: "AUTH_REQUIRED",
        detail: "Token expired",
      }), {
        status: 401,
        headers: {
          "content-type": "application/problem+json",
          "x-request-id": "request-1",
        },
      }),
    });

    const request = client.GET("/identity/me");

    await expect(request).rejects.toMatchObject({
      name: "WorkbenchApiError",
      message: "Token expired",
      status: 401,
      code: "AUTH_REQUIRED",
      requestId: "request-1",
      retryable: false,
    });
  });
});

describe("RFC 9457 fallback", () => {
  it("normalizes a non-problem response without losing the request id", async () => {
    const problem = await problemFromResponse(new Response(JSON.stringify({ message: "Gateway failed" }), {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "x-request-id": "request-2" },
    }));

    expect(problem).toEqual({
      type: "about:blank",
      title: "Bad Gateway",
      status: 502,
      code: "HTTP_502",
      detail: "Gateway failed",
      requestId: "request-2",
    });
  });
});
