// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authStorageProbe = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/auth/workbench-auth.server", () => ({
  checkWorkbenchAuthStorage: authStorageProbe,
}));

describe("Workbench health route", () => {
  beforeEach(() => {
    vi.resetModules();
    authStorageProbe.mockClear();
    vi.stubEnv("WORKBENCH_API_INTERNAL_URL", "http://workbench-api:4100/api/v1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("coalesces concurrent public checks and briefly caches the bounded result", async () => {
    const request = vi.fn(async () => Response.json({ status: "ready" }));
    vi.stubGlobal("fetch", request);
    const { GET } = await import("./route");

    const responses = await Promise.all(Array.from({ length: 8 }, () => GET()));
    const cached = await GET();

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(cached.status).toBe(200);
    expect(request).toHaveBeenCalledOnce();
    expect(authStorageProbe).toHaveBeenCalledOnce();
  });
});
