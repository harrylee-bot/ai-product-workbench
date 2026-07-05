import { BadRequestException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDeerflowService } from "../src/admin/admin-deerflow.service";

describe("AdminDeerflowService", () => {
  const originalEnabled = process.env.DEERFLOW_ENABLED;
  const originalGatewayUrl = process.env.DEERFLOW_GATEWAY_URL;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env.DEERFLOW_ENABLED = originalEnabled;
    process.env.DEERFLOW_GATEWAY_URL = originalGatewayUrl;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns an empty skill list without touching the gateway when DeerFlow is disabled", async () => {
    process.env.DEERFLOW_ENABLED = "false";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;

    const result = await new AdminDeerflowService().listSkills();

    expect(result).toEqual({ skills: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects skill updates when DeerFlow is disabled", async () => {
    process.env.DEERFLOW_ENABLED = "false";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;

    await expect(new AdminDeerflowService().updateSkill("demo", true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies skill reads to the configured gateway when DeerFlow is enabled", async () => {
    process.env.DEERFLOW_ENABLED = "true";
    process.env.DEERFLOW_GATEWAY_URL = "http://deerflow.local";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ skills: [{ name: "demo", description: "Demo", category: "custom", enabled: true }] }),
    });
    globalThis.fetch = fetchMock as never;

    const result = await new AdminDeerflowService().listSkills();

    expect(result.skills).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("http://deerflow.local/api/skills", expect.any(Object));
  });
});
