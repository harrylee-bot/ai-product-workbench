import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { ExportPreviewConfig } from "../src/modules/exports/export-preview.config.js";

const secret = Buffer.alloc(32, 11).toString("base64url");

describe("ExportPreviewConfig", () => {
  it("requires HTTPS Preview and Web origins in production", () => {
    expect(() => createConfig({
      NODE_ENV: "production",
      WORKBENCH_PREVIEW_ORIGIN: "http://preview.workbench.example",
    })).toThrow("WORKBENCH_PREVIEW_ORIGIN must be a bare HTTPS origin");

    expect(() => createConfig({
      NODE_ENV: "production",
      WORKBENCH_WEB_ORIGIN: "https://workbench.example,http://admin.workbench.example",
    })).toThrow("WORKBENCH_WEB_ORIGIN must be a bare HTTPS origin");
  });

  it("allows distinct HTTP origins for local development", () => {
    const config = createConfig({
      WORKBENCH_PREVIEW_ORIGIN: "http://preview.localhost:4300",
      WORKBENCH_WEB_ORIGIN: "http://localhost:3000",
    });
    expect(config.createCapability("export_1").url)
      .toMatch(/^http:\/\/preview\.localhost:4300\/preview\//u);
  });

  it("mints only HTTPS capabilities in a valid production configuration", () => {
    const config = createConfig({ NODE_ENV: "production" });
    expect(config.createCapability("export_1").url)
      .toMatch(/^https:\/\/preview\.workbench\.example\/preview\//u);
  });

  it("never mints a capability beyond the ProjectPreview lifetime", () => {
    const config = createConfig();
    const now = new Date("2026-07-15T00:00:00.000Z");
    const previewExpiry = new Date(now.getTime() + 15_000);

    expect(config.createCapability("preview-export-1", now, previewExpiry).expiresAt)
      .toEqual(previewExpiry);
    expect(() => config.createCapability("preview-export-1", now, now))
      .toThrow("PREVIEW_CAPABILITY_EXPIRY_INVALID");
  });
});

function createConfig(overrides: Record<string, string> = {}) {
  return new ExportPreviewConfig(new ConfigService({
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.workbench.example",
    WORKBENCH_WEB_ORIGIN: "https://workbench.example",
    WORKBENCH_PREVIEW_TOKEN_SECRET: secret,
    WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS: "60",
    ...overrides,
  }));
}
