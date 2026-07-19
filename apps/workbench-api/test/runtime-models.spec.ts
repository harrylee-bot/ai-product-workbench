import { ConfigService } from "@nestjs/config";
import { RuntimeModelsService } from "../src/modules/runtime/runtime-models.service.js";

function createService(overrides: Record<string, string> = {}) {
  return new RuntimeModelsService(new ConfigService({
    DEERFLOW_LANGGRAPH_URL: "https://deerflow.test/api/",
    DEERFLOW_INTERNAL_AUTH_TOKEN: "internal-secret",
    DEERFLOW_MODEL_CATALOG_TIMEOUT_MS: "50",
    ...overrides,
  }));
}

function validCatalog() {
  return {
    models: [{
      name: "quality",
      model: "provider-internal-model-name",
      display_name: "Quality model",
      description: "Best quality for complex work",
      supports_thinking: true,
      supports_reasoning_effort: true,
    }],
    token_usage: { enabled: true },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RuntimeModelsService", () => {
  it("loads DeerFlow with the internal token and returns only the public contract", async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://deerflow.test/api/models");
      expect(new Headers(init?.headers).get("x-deerflow-internal-token")).toBe("internal-secret");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return Response.json(validCatalog());
    });
    vi.stubGlobal("fetch", request);

    await expect(createService().list()).resolves.toEqual({
      items: [{
        id: "quality",
        displayName: "Quality model",
        description: "Best quality for complex work",
        supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
        supportsThinking: true,
        supportsReasoningEffort: true,
      }],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses the stable DeerFlow name as id and display fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...validCatalog(),
      models: [{
        ...validCatalog().models[0],
        name: "fast",
        display_name: null,
        description: null,
        supports_thinking: false,
        supports_reasoning_effort: false,
      }],
    })));

    await expect(createService().list()).resolves.toEqual({
      items: [{
        id: "fast",
        displayName: "fast",
        description: null,
        supportedWorkflows: ["generate", "redesign", "ideate", "edit"],
        supportsThinking: false,
        supportsReasoningEffort: false,
      }],
    });
  });

  it("accepts only the exact DeerFlow model.name from the current catalog", async () => {
    const request = vi.fn(async () => Response.json(validCatalog()));
    vi.stubGlobal("fetch", request);

    await expect(createService().assertAvailable("quality", "edit")).resolves.toBeUndefined();
    await expect(createService().assertAvailable("provider-internal-model-name", "edit")).rejects.toMatchObject({
      status: 400,
      response: {
        title: "Invalid runtime model",
        code: "RUNTIME_MODEL_NOT_FOUND",
        detail: "The selected runtime model is not present in the current DeerFlow catalog",
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a model/workflow pair outside the public capability catalog", async () => {
    const service = createService();
    vi.spyOn(service, "list").mockResolvedValue({
      items: [{
        id: "generate-only",
        displayName: "Generate only",
        description: null,
        supportedWorkflows: ["generate"],
        supportsThinking: false,
        supportsReasoningEffort: false,
      }],
    });

    await expect(service.assertAvailable("generate-only", "edit")).rejects.toMatchObject({
      status: 400,
      response: {
        code: "VALIDATION_ERROR",
        detail: "The selected runtime model does not support the requested workflow",
        errors: { workflow: ["generate-only does not support edit"] },
      },
    });
  });

  it("rejects non-success and protocol-drift responses as RFC 9457 problems", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: "private upstream error" }, {
      status: 503,
    })));
    await expect(createService().list()).rejects.toMatchObject({
      status: 502,
      response: {
        code: "RUNTIME_MODEL_CATALOG_UNAVAILABLE",
        detail: "The runtime model catalog could not be loaded",
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...validCatalog(),
      internal_config: { api_key: "must-never-pass" },
    })));
    await expect(createService().list()).rejects.toMatchObject({ status: 502 });
  });

  it("aborts a slow catalog request at the configured deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })));

    const rejection = expect(createService({
      DEERFLOW_MODEL_CATALOG_TIMEOUT_MS: "25",
    }).list()).rejects.toMatchObject({
      status: 504,
      response: { code: "RUNTIME_MODEL_CATALOG_TIMEOUT" },
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise<unknown>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
    }) as Response));
    const bodyRejection = expect(createService({
      DEERFLOW_MODEL_CATALOG_TIMEOUT_MS: "25",
    }).list()).rejects.toMatchObject({
      status: 504,
      response: { code: "RUNTIME_MODEL_CATALOG_TIMEOUT" },
    });
    await vi.advanceTimersByTimeAsync(25);
    await bodyRejection;
  });

  it("fails fast when the internal catalog configuration is unsafe", () => {
    expect(() => createService({ DEERFLOW_INTERNAL_AUTH_TOKEN: "" })).toThrow(
      "Missing DEERFLOW_INTERNAL_AUTH_TOKEN",
    );
    expect(() => createService({
      DEERFLOW_LANGGRAPH_URL: "https://user:pass@deerflow.test/api?token=leak",
    })).toThrow(/must not contain credentials/);
    expect(() => createService({
      DEERFLOW_MODEL_CATALOG_TIMEOUT_MS: "0",
    })).toThrow(/between 1 and 60000/);
    expect(() => createService({
      DEERFLOW_MODEL_CATALOG_TIMEOUT_MS: "60001",
    })).toThrow(/between 1 and 60000/);
  });
});
