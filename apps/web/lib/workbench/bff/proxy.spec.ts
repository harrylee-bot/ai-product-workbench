import { describe, expect, it, vi } from "vitest";

import { createWorkbenchBffHandler } from "./proxy";

const origin = "https://workbench.example.com";

describe("Workbench same-origin BFF", () => {
  it("injects a server token and strips browser credentials and development identity", async () => {
    const upstreamFetch = vi.fn(async (target: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(target)).toBe(
        "http://workbench-api:4100/api/v1/projects/project%2Fone?cursor=next",
      );
      expect(headers.get("authorization")).toBe("Bearer internal-jwt");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-workbench-dev-subject")).toBeNull();
      expect(headers.get("idempotency-key")).toBe("project:request_123");
      expect(await new Response(init?.body).text()).toBe('{"title":"Project"}');
      return new Response("ok", {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "upstream=forbidden",
          "X-Request-Id": "request-1",
        },
      });
    });
    const getBearerToken = vi.fn(async () => "internal-jwt");
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken,
      fetch: upstreamFetch as typeof fetch,
    });

    const response = await handler(
      new Request(`${origin}/api/v1/projects/project%2Fone?cursor=next`, {
        method: "POST",
        headers: {
          Authorization: "Bearer browser-token",
          Cookie: "workbench.session_token=session-1",
          "Content-Type": "application/json",
          "Idempotency-Key": "project:request_123",
          Origin: origin,
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "workbench=release-1",
          baggage: "workspace.id=workspace-1",
          "x-workbench-dev-subject": "forged-user",
        },
        body: '{"title":"Project"}',
      }),
      ["projects", "project/one"],
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("ok");
    expect(getBearerToken).toHaveBeenCalledOnce();
    const forwarded = new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers);
    expect(forwarded.get("traceparent")).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(forwarded.get("tracestate")).toBe("workbench=release-1");
    expect(forwarded.get("baggage")).toBeNull();
  });

  it("drops malformed W3C trace context instead of forwarding spoofed identifiers", async () => {
    let forwarded = new Headers();
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken: async () => null,
      fetch: vi.fn(async (_target, init) => {
        forwarded = new Headers(init?.headers);
        return Response.json({ ok: true });
      }) as typeof fetch,
    });

    await handler(new Request(`${origin}/api/v1/identity/me`, {
      headers: {
        traceparent: "00-00000000000000000000000000000000-0000000000000000-01",
        tracestate: `workbench=${"x".repeat(600)}`,
        baggage: "invalid\u0001value",
      },
    }), ["identity", "me"]);

    expect(forwarded.has("traceparent")).toBe(false);
    expect(forwarded.has("tracestate")).toBe(false);
    expect(forwarded.has("baggage")).toBe(false);
  });

  it("proxies public GET and streamed responses without requiring a session", async () => {
    const encoder = new TextEncoder();
    let forwardedHeaders = new Headers();
    const upstreamFetch = vi.fn(async (_target: URL | RequestInfo, init?: RequestInit) => {
      forwardedHeaders = new Headers(init?.headers);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("event: run.started\n\n"));
          controller.close();
        },
      }), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    });
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1/",
      expectedOrigin: origin,
      getBearerToken: async () => null,
      fetch: upstreamFetch as typeof fetch,
    });

    const response = await handler(
      new Request(`${origin}/api/v1/public/shares/share_1`),
      ["public", "shares", "share_1"],
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: run.started\n\n");
    expect(forwardedHeaders.has("authorization")).toBe(false);
  });

  it("preserves private conditional GET headers and an empty 304 response", async () => {
    const etag = `"avp1.3.${"a".repeat(43)}"`;
    const upstreamFetch = vi.fn(async (_target: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe(etag);
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-cache" },
      });
    });
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken: async () => "internal-jwt",
      fetch: upstreamFetch as typeof fetch,
    });

    const response = await handler(new Request(
      `${origin}/api/v1/artifacts/artifact-1/versions/version-1/preference`,
      { headers: { "If-None-Match": etag } },
    ), ["artifacts", "artifact-1", "versions", "version-1", "preference"]);

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(await response.text()).toBe("");
  });

  it("rejects cross-origin mutations before reading auth or contacting the API", async () => {
    const getBearerToken = vi.fn(async () => "token");
    const upstreamFetch = vi.fn();
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken,
      fetch: upstreamFetch as typeof fetch,
    });

    const response = await handler(new Request(`${origin}/api/v1/projects`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: "{}",
    }), ["projects"]);

    expect(response.status).toBe(403);
    expect(getBearerToken).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects declared and streamed request bodies over the configured limit", async () => {
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      maximumRequestBytes: 4,
      getBearerToken: async () => null,
      fetch: vi.fn() as typeof fetch,
    });

    const declared = await handler(new Request(`${origin}/api/v1/projects`, {
      method: "POST",
      headers: { Origin: origin, "Content-Length": "5" },
      body: "12345",
    }), ["projects"]);
    const measured = await handler(new Request(`${origin}/api/v1/projects`, {
      method: "POST",
      headers: { Origin: origin },
      body: "12345",
    }), ["projects"]);

    expect(declared.status).toBe(413);
    expect(measured.status).toBe(413);
  });

  it("does not expose internal liveness or readiness probes through the browser BFF", async () => {
    const upstreamFetch = vi.fn();
    const getBearerToken = vi.fn(async () => null);
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken,
      fetch: upstreamFetch as typeof fetch,
    });

    for (const probe of ["live", "ready"]) {
      const response = await handler(
        new Request(`${origin}/api/v1/system/${probe}`),
        ["system", probe],
      );
      expect(response.status).toBe(404);
    }
    expect(getBearerToken).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("returns a bounded problem response when the internal API is unavailable", async () => {
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken: async () => null,
      fetch: vi.fn(async () => {
        throw new Error("internal address must not leak");
      }) as typeof fetch,
    });

    const response = await handler(
      new Request(`${origin}/api/v1/public/shares/share_1`),
      ["public", "shares", "share_1"],
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(expect.objectContaining({
      status: 502,
      title: "产品工作台服务暂不可用",
      detail: "产品工作台服务暂不可用",
    }));
  });

  it("fails closed without leaking session errors when auth storage is unavailable", async () => {
    const upstreamFetch = vi.fn();
    const handler = createWorkbenchBffHandler({
      upstreamBaseUrl: "http://workbench-api:4100/api/v1",
      expectedOrigin: origin,
      getBearerToken: async () => {
        throw new Error("database address must not leak");
      },
      fetch: upstreamFetch as typeof fetch,
    });

    const response = await handler(
      new Request(`${origin}/api/v1/identity/me`),
      ["identity", "me"],
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expect.objectContaining({
      status: 503,
      title: "登录服务暂不可用",
      detail: "产品工作台登录服务暂不可用",
    }));
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
