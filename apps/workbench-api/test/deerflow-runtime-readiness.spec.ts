import { ConfigService } from "@nestjs/config";
import { DeerFlowRuntimeReadinessService } from "../src/modules/runtime/deerflow-runtime-readiness.service.js";

function createService(options: {
  config?: Record<string, string>;
  models?: { items: Array<{ id: string }> };
} = {}) {
  const models = {
    list: vi.fn().mockResolvedValue(options.models ?? { items: [{ id: "quality" }] }),
  };
  const service = new DeerFlowRuntimeReadinessService(new ConfigService({
    DEERFLOW_GATEWAY_URL: "https://deerflow.test",
    DEERFLOW_INTERNAL_AUTH_TOKEN: "internal-secret",
    DEERFLOW_READINESS_TIMEOUT_MS: "50",
    ...options.config,
  }), models as never);
  return { models, service };
}

function skillCatalog(category = "public", enabled = true) {
  return {
    skills: [{
      name: "workbench",
      category,
      enabled,
      editable: false,
    }],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DeerFlowRuntimeReadinessService", () => {
  it("requires a real model and an enabled PUBLIC workbench skill for a fresh tenant", async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://deerflow.test/api/skills");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-deerflow-internal-token")).toBe("internal-secret");
      expect(headers.get("x-deerflow-owner-user-id")).toBe("workbench-readiness");
      return Response.json(skillCatalog());
    });
    vi.stubGlobal("fetch", request);
    const { models, service } = createService();

    await expect(service.assertReady()).resolves.toBeUndefined();
    expect(models.list).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["legacy", true],
    ["custom", true],
    ["public", false],
  ])("rejects a %s skill with enabled=%s", async (category, enabled) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(skillCatalog(category, enabled))));
    await expect(createService().service.assertReady())
      .rejects.toThrow("DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED");
  });

  it("rejects an empty model catalog even when the skill is ready", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(skillCatalog())));
    await expect(createService({ models: { items: [] } }).service.assertReady())
      .rejects.toThrow("DEERFLOW_MODEL_CATALOG_EMPTY");
  });

  it("bounds and validates the upstream skill response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json")));
    await expect(createService().service.assertReady())
      .rejects.toThrow("DEERFLOW_SKILL_CATALOG_INVALID");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1_000_001))));
    await expect(createService().service.assertReady())
      .rejects.toThrow("DEERFLOW_SKILL_CATALOG_INVALID");
  });

  it("aborts an unavailable skill catalog at the configured deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })));
    const rejection = expect(createService({
      config: { DEERFLOW_READINESS_TIMEOUT_MS: "25" },
    }).service.assertReady()).rejects.toThrow("DEERFLOW_SKILL_CATALOG_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("fails fast for missing or unsafe Gateway configuration", () => {
    expect(() => createService({ config: { DEERFLOW_GATEWAY_URL: "" } }))
      .toThrow("Missing DEERFLOW_GATEWAY_URL");
    expect(() => createService({
      config: { DEERFLOW_GATEWAY_URL: "https://user:pass@deerflow.test?token=secret" },
    })).toThrow(/must not contain credentials/);
    expect(() => createService({ config: { DEERFLOW_READINESS_TIMEOUT_MS: "0" } }))
      .toThrow(/between 1 and 60000/);
  });
});
