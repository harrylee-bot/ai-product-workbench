import { describe, expect, it } from "vitest";
import {
  externalExportProviderAvailable,
  loadExternalExportProviderConfig,
} from "../src/external-export-provider-config.js";

describe("external Export provider configuration", () => {
  it("keeps Netlify unavailable when no provider credential is configured", () => {
    const config = loadExternalExportProviderConfig({ NODE_ENV: "production" });
    expect(config.netlify).toBeNull();
    expect(externalExportProviderAvailable(config, "netlify")).toBe(false);
  });

  it("enables Netlify only from one complete shared configuration", () => {
    const config = loadExternalExportProviderConfig({
      NODE_ENV: "production",
      WORKBENCH_NETLIFY_SITE_ID: "site_123",
      WORKBENCH_NETLIFY_ACCESS_TOKEN: "secret-token",
      WORKBENCH_NETLIFY_REQUEST_TIMEOUT_MS: "90000",
      WORKBENCH_NETLIFY_POLL_INTERVAL_MS: "250",
    });

    expect(config.netlify).toEqual({
      siteId: "site_123",
      accessToken: "secret-token",
      apiBaseUrl: "https://api.netlify.com/api/v1",
      requestTimeoutMs: 90_000,
      pollIntervalMs: 250,
    });
    expect(externalExportProviderAvailable(config, "netlify")).toBe(true);
    expect(externalExportProviderAvailable(config, "lovable")).toBe(false);
  });

  it("rejects partial, credential-bearing, and insecure production configuration", () => {
    expect(() => loadExternalExportProviderConfig({
      WORKBENCH_NETLIFY_SITE_ID: "site_123",
    })).toThrow(/must be configured together/u);

    expect(() => loadExternalExportProviderConfig({
      WORKBENCH_NETLIFY_SITE_ID: "site_123",
      WORKBENCH_NETLIFY_ACCESS_TOKEN: "secret-token",
      WORKBENCH_NETLIFY_API_BASE_URL: "https://token@example.test/api/v1",
    })).toThrow(/without credentials/u);

    expect(() => loadExternalExportProviderConfig({
      NODE_ENV: "production",
      WORKBENCH_NETLIFY_SITE_ID: "site_123",
      WORKBENCH_NETLIFY_ACCESS_TOKEN: "secret-token",
      WORKBENCH_NETLIFY_API_BASE_URL: "http://netlify.internal.test/api/v1",
    })).toThrow(/must use HTTPS in production/u);
  });
});
