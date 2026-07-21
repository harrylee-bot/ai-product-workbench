import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExportWorkerConfig } from "../src/config.js";

describe("export worker S3 role configuration", () => {
  beforeEach(() => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://user:pass@db:5432/workbench?schema=workbench");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_EXPORT_S3_ACCESS_KEY_ID", "export-access");
    vi.stubEnv("WORKBENCH_EXPORT_S3_SECRET_ACCESS_KEY", "export-secret");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("loads only the dedicated Export Worker credential", () => {
    expect(loadExportWorkerConfig()).toMatchObject({
      exportS3AccessKeyId: "export-access",
      exportS3SecretAccessKey: "export-secret",
      s3ConditionalCreateMode: "s3-if-none-match",
    });
  });

  it("supports OSS create-only writes without accepting unknown modes", () => {
    vi.stubEnv("WORKBENCH_S3_CONDITIONAL_CREATE_MODE", "oss-forbid-overwrite");
    expect(loadExportWorkerConfig().s3ConditionalCreateMode).toBe("oss-forbid-overwrite");
    vi.stubEnv("WORKBENCH_S3_CONDITIONAL_CREATE_MODE", "overwrite");
    expect(() => loadExportWorkerConfig()).toThrow("WORKBENCH_S3_CONDITIONAL_CREATE_MODE");
  });

  it("fails closed instead of falling back to generic S3 credentials", () => {
    vi.stubEnv("WORKBENCH_EXPORT_S3_ACCESS_KEY_ID", "");
    vi.stubEnv("WORKBENCH_EXPORT_S3_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-access");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    expect(() => loadExportWorkerConfig()).toThrow("Missing WORKBENCH_EXPORT_S3_ACCESS_KEY_ID");
  });

  it("keeps lease takeover later than the delivery queue execution deadline", () => {
    vi.stubEnv("WORKBENCH_EXPORT_STALE_RUNNING_MS", String(15 * 60 * 1_000));
    expect(() => loadExportWorkerConfig()).toThrow(
      "WORKBENCH_EXPORT_STALE_RUNNING_MS must exceed the export.delivery job expiration",
    );

    vi.stubEnv("WORKBENCH_EXPORT_STALE_RUNNING_MS", String(15 * 60 * 1_000 + 1));
    expect(loadExportWorkerConfig().staleRunningMs).toBe(15 * 60 * 1_000 + 1);
  });
});
