import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-storage", () => ({
  clearSession: vi.fn(),
}));

const { clearSession } = await import("./auth-storage");
const { ApiError, apiRequest, streamApiEvents, downloadApiFile, assertWorkbenchApiAvailable } = await import("./api");

const fetchMock = vi.fn<typeof fetch>();
const dispatchSpy = vi.spyOn(window, "dispatchEvent");

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API client", () => {
  it("uses httpOnly-cookie credentials instead of Authorization headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(apiRequest("/projects", { method: "POST", body: JSON.stringify({ title: "签到" }) })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:4000/api/projects", expect.objectContaining({
      method: "POST",
      credentials: "include",
      headers: expect.any(Headers),
    }));
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("clears local legacy session and dispatches auth expiry on 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "未登录" }, { status: 401 }));

    await expect(apiRequest("/auth/me")).rejects.toEqual(expect.objectContaining({
      name: "ApiError",
      message: "未登录",
      status: 401,
    }));

    expect(clearSession).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "auth:expired" }));
  });

  it("can suppress initial auth expiry event for boot-time session probing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "未登录" }, { status: 401 }));

    await expect(apiRequest("/auth/me", { suppressAuthExpiredEvent: true })).rejects.toBeInstanceOf(ApiError);

    expect(clearSession).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("streams SSE events with credentials", async () => {
    fetchMock.mockResolvedValueOnce(new Response([
      "event: message_delta",
      "data: {\"content\":\"你好\"}",
      "",
    ].join("\n"), { status: 200 }));
    const events: unknown[] = [];

    await streamApiEvents("/ai/vibe/runs/run-1/stream", (event, meta) => events.push({ event, meta }));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/ai/vibe/runs/run-1/stream",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(events).toEqual([{ event: { content: "你好" }, meta: { type: "message_delta" } }]);
  });

  it("downloads blobs with credentials and server-provided filename", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:download");
    const revokeObjectURL = vi.fn();
    const originalUrl = window.URL;
    Object.defineProperty(window, "URL", {
      configurable: true,
      value: { ...originalUrl, createObjectURL, revokeObjectURL },
    });
    const appendChild = vi.spyOn(document.body, "appendChild");
    let clickedDownload = "";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownload = this.download;
    });
    fetchMock.mockResolvedValueOnce(new Response("file", {
      status: 200,
      headers: { "Content-Disposition": "attachment; filename*=UTF-8''prototype.html" },
    }));

    try {
      await downloadApiFile("/projects/project-1/export/html");
    } finally {
      Object.defineProperty(window, "URL", { configurable: true, value: originalUrl });
      appendChild.mockRestore();
      click.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/projects/project-1/export/html",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).toHaveProperty("size", 4);
    expect(clickedDownload).toBe("prototype.html");
  });

  it("requires the health payload to expose the expected service and projects module", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      service: "ai-product-workbench-api",
      deerflow: { enabled: true },
      modules: ["projects"],
    }));

    await expect(assertWorkbenchApiAvailable()).resolves.toBeUndefined();
  });
});

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
