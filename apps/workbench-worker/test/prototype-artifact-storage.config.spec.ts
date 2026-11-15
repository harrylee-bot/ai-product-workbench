import { describe, expect, it } from "vitest";
import { loadPrototypeArtifactStorageConfig } from "../src/prototypes/prototype-artifact-storage.config.js";

describe("Temporal prototype artifact storage configuration", () => {
  it.each(["false", "true"])("respects explicit path style %s with a custom endpoint", value => {
    expect(loadPrototypeArtifactStorageConfig({ WORKBENCH_S3_INTERNAL_ENDPOINT: "https://storage.test", WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: value }).artifactForcePathStyle).toBe(value === "true");
  });

  it.each([undefined, "https://storage.test"])("preserves the endpoint-derived default for %s", endpoint => {
    const config = loadPrototypeArtifactStorageConfig({ WORKBENCH_S3_INTERNAL_ENDPOINT: endpoint });
    expect(config.artifactForcePathStyle).toBe(Boolean(endpoint));
    expect(config.artifactConditionalCreateMode).toBe("s3-if-none-match");
  });

  it("loads OSS mode and the dedicated artifact role without changing the shared source role", () => {
    expect(loadPrototypeArtifactStorageConfig({
      WORKBENCH_S3_BUCKET: "source-bucket",
      WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET: "artifact-bucket",
      WORKBENCH_PROTOTYPE_ARTIFACT_S3_PREFIX: "frozen",
      WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "oss-forbid-overwrite",
      WORKBENCH_PROTOTYPE_ARTIFACT_S3_ACCESS_KEY_ID: "artifact-test-key",
      WORKBENCH_PROTOTYPE_ARTIFACT_S3_SECRET_ACCESS_KEY: "artifact-test-secret",
    })).toMatchObject({ artifactBucket: "artifact-bucket", artifactPrefix: "frozen", artifactConditionalCreateMode: "oss-forbid-overwrite", artifactAccessKeyId: "artifact-test-key", artifactSecretAccessKey: "artifact-test-secret" });
  });

  it("rejects invalid write protocol and path-style settings before worker startup", () => {
    expect(() => loadPrototypeArtifactStorageConfig({ WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "unsafe-overwrite" })).toThrow("WORKBENCH_S3_CONDITIONAL_CREATE_MODE");
    expect(() => loadPrototypeArtifactStorageConfig({ WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: "enabled" })).toThrow("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE");
  });
});
