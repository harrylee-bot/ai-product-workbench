import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPreviewConfig } from "../src/config.js";

describe("Preview S3 role configuration", () => {
  beforeEach(() => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://user:pass@db:5432/workbench?schema=workbench");
    vi.stubEnv("WORKBENCH_PREVIEW_ORIGIN", "https://preview.workbench.test");
    vi.stubEnv("WORKBENCH_WEB_ORIGIN", "https://workbench.test");
    vi.stubEnv("WORKBENCH_PREVIEW_TOKEN_SECRET", Buffer.alloc(32, 3).toString("base64url"));
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID", "preview-access");
    vi.stubEnv("WORKBENCH_PREVIEW_S3_SECRET_ACCESS_KEY", "preview-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("loads only the dedicated Preview read credential", () => {
    expect(loadPreviewConfig()).toMatchObject({
      previewS3AccessKeyId: "preview-access",
      previewS3SecretAccessKey: "preview-secret",
      maximumConcurrency: 4,
      spoolDirectory: expect.stringContaining("workbench-preview"),
    });
  });

  it("requires an absolute non-root spool directory", () => {
    vi.stubEnv("WORKBENCH_PREVIEW_SPOOL_DIR", "relative/spool");
    expect(() => loadPreviewConfig()).toThrow(
      "WORKBENCH_PREVIEW_SPOOL_DIR must be an absolute non-root directory",
    );
    vi.stubEnv("WORKBENCH_PREVIEW_SPOOL_DIR", "/var/lib/workbench-preview");
    expect(loadPreviewConfig()).toMatchObject({
      spoolDirectory: "/var/lib/workbench-preview",
    });
  });

  it("fails closed instead of falling back to generic S3 credentials", () => {
    vi.stubEnv("WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID", "");
    vi.stubEnv("WORKBENCH_PREVIEW_S3_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-access");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    expect(() => loadPreviewConfig()).toThrow("Missing WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID");
  });

  it("requires HTTPS Preview and Web origins in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loadPreviewConfig()).toMatchObject({
      publicOrigin: "https://preview.workbench.test",
      webOrigin: "https://workbench.test",
    });

    vi.stubEnv("WORKBENCH_PREVIEW_ORIGIN", "http://preview.workbench.test");
    expect(() => loadPreviewConfig()).toThrow(
      "WORKBENCH_PREVIEW_ORIGIN must be a bare HTTPS origin",
    );

    vi.stubEnv("WORKBENCH_PREVIEW_ORIGIN", "https://preview.workbench.test");
    vi.stubEnv("WORKBENCH_WEB_ORIGIN", "http://workbench.test");
    expect(() => loadPreviewConfig()).toThrow(
      "WORKBENCH_WEB_ORIGIN must be a bare HTTPS origin",
    );
  });

  it("allows distinct HTTP origins for local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WORKBENCH_PREVIEW_ORIGIN", "http://preview.localhost:4300");
    vi.stubEnv("WORKBENCH_WEB_ORIGIN", "http://localhost:3000");
    expect(loadPreviewConfig()).toMatchObject({
      publicOrigin: "http://preview.localhost:4300",
      webOrigin: "http://localhost:3000",
    });
  });
});
