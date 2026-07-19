import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeWorkbenchApiBaseUrl } from "./config";
import {
  createWorkbenchFetch,
  createWorkbenchRequestDecorator,
} from "./request-fetch";

describe("Workbench same-origin request fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes browser bearer and development identity headers without changing request data", async () => {
    const decorator = createWorkbenchRequestDecorator();
    const request = new Request("http://workbench.test/api/v1/projects", {
      method: "POST",
      headers: {
        Authorization: "Bearer forged",
        "Proxy-Authorization": "Basic forged",
        "x-workbench-dev-subject": "forged-subject",
        "x-workbench-dev-email": "forged@example.com",
        "x-workbench-dev-name": "Forged User",
        "Content-Type": "application/json",
        "Idempotency-Key": "project:request_123",
      },
      body: '{"title":"Project"}',
    });

    const decorated = await decorator(request);

    expect(decorated.headers.get("authorization")).toBeNull();
    expect(decorated.headers.get("proxy-authorization")).toBeNull();
    expect(decorated.headers.get("x-workbench-dev-subject")).toBeNull();
    expect(decorated.headers.get("x-workbench-dev-email")).toBeNull();
    expect(decorated.headers.get("x-workbench-dev-name")).toBeNull();
    expect(decorated.headers.get("content-type")).toBe("application/json");
    expect(decorated.headers.get("idempotency-key")).toBe("project:request_123");
    expect(await decorated.text()).toBe('{"title":"Project"}');
  });

  it("always sends Cookie-authenticated same-origin requests after clearing identity headers", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.credentials).toBe("same-origin");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-workbench-dev-subject")).toBeNull();
      return Response.json({ ok: true });
    });
    const workbenchFetch = createWorkbenchFetch({ fetch });

    await workbenchFetch(new Request("http://workbench.test/api/v1/identity/me", {
      credentials: "omit",
      headers: {
        Authorization: "Bearer manually-injected",
        "x-workbench-dev-subject": "forged-subject",
      },
    }));

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("allows only the current browser origin and the /api/v1 BFF base", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://workbench.example.com" },
    });

    expect(normalizeWorkbenchApiBaseUrl("/api/v1/"))
      .toBe("https://workbench.example.com/api/v1");
    expect(() => normalizeWorkbenchApiBaseUrl("https://api.example.com/api/v1"))
      .toThrow(/same-origin \/api\/v1 BFF/);
    expect(() => normalizeWorkbenchApiBaseUrl("/internal-api/v1"))
      .toThrow(/same-origin \/api\/v1 BFF/);
    expect(() => normalizeWorkbenchApiBaseUrl("/api/v1?target=internal"))
      .toThrow(/same-origin \/api\/v1 BFF/);
  });

  it("rejects a direct cross-origin request before invoking fetch", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://workbench.example.com" },
    });
    const fetch = vi.fn();
    const workbenchFetch = createWorkbenchFetch({ fetch });

    await expect(workbenchFetch(new Request("https://api.example.com/api/v1/identity/me")))
      .rejects.toThrow(/same-origin \/api\/v1 BFF/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
