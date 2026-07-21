import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductionBuildConfiguration,
  verifyProductionBuildConfiguration,
} from "./write-production-build-configuration.mjs";

const base = {
  id: "web",
  sourceCommit: "a".repeat(40),
  dockerfile: "apps/web/Dockerfile",
  target: "runner",
};

test("canonicalizes public build arguments and verifies candidate binding", () => {
  const first = createProductionBuildConfiguration({
    ...base,
    buildArgsSource: "WORKBENCH_PREVIEW_ORIGIN=https://preview.example.test\nNEXT_PUBLIC_ENABLED=false\n",
  });
  const reordered = createProductionBuildConfiguration({
    ...base,
    buildArgsSource: "NEXT_PUBLIC_ENABLED=false\nWORKBENCH_PREVIEW_ORIGIN=https://preview.example.test",
  });
  assert.equal(first.payloadSha256, reordered.payloadSha256);
  assert.deepEqual(first.buildArgs, {
    NEXT_PUBLIC_ENABLED: "false",
    WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.test",
  });
  assert.equal(verifyProductionBuildConfiguration(first, base), true);
});

test("rejects tampering, duplicates, secrets, and cross-candidate configuration", () => {
  const configuration = createProductionBuildConfiguration({ ...base, buildArgsSource: "PUBLIC_ORIGIN=https://example.test" });
  assert.throws(
    () => verifyProductionBuildConfiguration({ ...configuration, buildArgs: { PUBLIC_ORIGIN: "https://other.test" } }),
    /SHA-256 mismatch/u,
  );
  assert.throws(
    () => createProductionBuildConfiguration({ ...base, buildArgsSource: "PUBLIC_ORIGIN=a\nPUBLIC_ORIGIN=b" }),
    /duplicate/u,
  );
  assert.throws(
    () => createProductionBuildConfiguration({ ...base, buildArgsSource: "API_TOKEN=credential-value" }),
    /secret-like/u,
  );
  assert.throws(
    () => verifyProductionBuildConfiguration(configuration, { ...base, sourceCommit: "b".repeat(40) }),
    /sourceCommit mismatch/u,
  );
});
