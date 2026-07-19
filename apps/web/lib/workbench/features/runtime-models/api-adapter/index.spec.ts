import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchRuntimeModelsApi } from "./index";

describe("Runtime Models API contracts", () => {
  it("loads and strictly validates the Runtime Model catalog", async () => {
    const catalog = { items: [model()] };
    const responses = [catalog, { ...catalog, internalProof: "not-public" }];
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://workbench.test/api/v1/runtime/models");
      expect(request.method).toBe("GET");
      return Response.json(responses.shift());
    });
    const api = new WorkbenchRuntimeModelsApi(createWorkbenchApiClient({
      baseUrl: "http://workbench.test/api/v1",
      fetch,
    }));

    await expect(api.listRuntimeModels()).resolves.toEqual(catalog);
    await expect(api.listRuntimeModels()).rejects.toBeInstanceOf(WorkbenchContractError);
  });
});

function model() {
  return {
    id: "quality",
    displayName: "Quality model",
    description: null,
    supportedWorkflows: ["generate", "redesign", "ideate", "edit"] as const,
    supportsThinking: true,
    supportsReasoningEffort: false,
  };
}
