import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadImportWorkerConfig } from "../src/config.js";
import { maximumImportSourceManifestBlobs } from "../src/import/source-types.js";

describe("Import Worker configuration", () => {
  beforeEach(() => {
    vi.stubEnv("WORKBENCH_DATABASE_URL", "postgresql://user:pass@db:5432/workbench?schema=workbench");
    vi.stubEnv("WORKBENCH_S3_BUCKET", "workbench");
    vi.stubEnv("WORKBENCH_IMPORT_S3_ACCESS_KEY_ID", "import-access");
    vi.stubEnv("WORKBENCH_IMPORT_S3_SECRET_ACCESS_KEY", "import-secret");
    vi.stubEnv("WORKBENCH_IMPORT_MAX_GITHUB_FILES", "");
    vi.stubEnv("WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES", "");
    vi.stubEnv("WORKBENCH_FILE_SCAN_MODE", "fail-closed");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the 50-entry Source manifest ceiling as the GitHub default", () => {
    const config = loadImportWorkerConfig();

    expect(config.maximumGithubFiles).toBe(maximumImportSourceManifestBlobs);
    expect(config.maximumImportBlobBytes).toBe(50 * 1024 * 1024);
    expect(config.clamAvStreamMaxBytes).toBe(50 * 1024 * 1024);
    expect(config.queueConnectionString).toBe("postgresql://user:pass@db:5432/workbench");
    expect(config.scanMode).toBe("fail-closed");
  });

  it("allows operators to tighten but never exceed the Source manifest ceiling", () => {
    vi.stubEnv("WORKBENCH_IMPORT_MAX_GITHUB_FILES", "25");
    expect(loadImportWorkerConfig().maximumGithubFiles).toBe(25);

    vi.stubEnv("WORKBENCH_IMPORT_MAX_GITHUB_FILES", String(maximumImportSourceManifestBlobs + 1));
    expect(() => loadImportWorkerConfig()).toThrow(
      `WORKBENCH_IMPORT_MAX_GITHUB_FILES must be a positive integer no greater than ${maximumImportSourceManifestBlobs}`,
    );
  });

  it("fails fast when an external blob can exceed the ClamAV stream capacity", () => {
    vi.stubEnv("WORKBENCH_IMPORT_MAX_GITHUB_BYTES", String(100 * 1024 * 1024));
    vi.stubEnv("WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES", String(50 * 1024 * 1024));

    expect(() => loadImportWorkerConfig()).toThrow(
      "WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES must cover the largest configured external import blob",
    );
  });

  it("does not inherit the File Worker ClamAV stream contract", () => {
    vi.stubEnv("WORKBENCH_CLAMAV_STREAM_MAX_BYTES", String(25 * 1024 * 1024));

    expect(loadImportWorkerConfig().clamAvStreamMaxBytes).toBe(50 * 1024 * 1024);
  });
});
