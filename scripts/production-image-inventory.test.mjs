import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleProductionImageManifest,
  verifyProductionImageManifest,
} from "./production-image-inventory.mjs";

const commit = "a".repeat(40);

test("assembles only the exact candidate image inventory", () => {
  const records = requiredImageIds().map(imageRecord);
  const manifest = assembleProductionImageManifest({ records, expectedCommit: commit });
  assert.equal(manifest.images.length, records.length);
  assert(manifest.images.some((entry) => entry.id === "import-worker"));
  assert(manifest.images.some((entry) => entry.id === "deerflow"));
});

test("rejects a missing Import Worker image", () => {
  const manifest = candidateManifest(requiredImageIds().filter((id) => id !== "import-worker"));
  assert.throws(
    () => verifyProductionImageManifest({ manifest, expectedCommit: commit }),
    /exact deploy inventory/u,
  );
});

test("rejects a cross-candidate image record", () => {
  const manifest = candidateManifest();
  manifest.images[0].sourceCommit = "b".repeat(40);
  assert.throws(
    () => verifyProductionImageManifest({ manifest, expectedCommit: commit }),
    /source commit mismatch/u,
  );
});

test("rejects duplicate image records", () => {
  const manifest = candidateManifest();
  manifest.images.push({ ...manifest.images[0] });
  assert.throws(
    () => verifyProductionImageManifest({ manifest, expectedCommit: commit }),
    /duplicate IDs/u,
  );
});

test("rejects unverified signatures and scan findings", () => {
  const unverified = candidateManifest();
  unverified.images[0].signature.verified = false;
  assert.throws(
    () => verifyProductionImageManifest({ manifest: unverified, expectedCommit: commit }),
    /signature was not independently verified/u,
  );

  const vulnerable = candidateManifest();
  vulnerable.images[0].vulnerabilityReport.high = 1;
  assert.throws(
    () => verifyProductionImageManifest({ manifest: vulnerable, expectedCommit: commit }),
    /has high vulnerabilities/u,
  );
});

test("binds the deployed DeerFlow reference to the signed record", () => {
  const manifest = candidateManifest();
  const deerflow = manifest.images.find((entry) => entry.id === "deerflow");
  const deploymentEnvironment = new Map([["WORKBENCH_DEERFLOW_IMAGE_REF", `${deerflow.imageRef}-wrong`]]);
  assert.throws(
    () => verifyProductionImageManifest({
      manifest,
      expectedCommit: commit,
      deploymentEnvironment,
      onlyImageId: "deerflow",
    }),
    /does not match signed image evidence/u,
  );
});

function candidateManifest(ids = requiredImageIds()) {
  return {
    schemaVersion: 1,
    candidate: { sourceCommit: commit },
    images: ids.map(imageRecord),
  };
}

function imageRecord(id) {
  const digest = `sha256:${id === "deerflow" ? "d" : "c"}${"0".repeat(63)}`;
  const evidence = () => ({ sha256: "e".repeat(64), uri: `urn:sha256:${"e".repeat(64)}` });
  return {
    id,
    imageRef: `registry.example.test/workbench/${id}@${digest}`,
    digest,
    sourceCommit: commit,
    sbom: evidence(),
    provenance: evidence(),
    signature: { ...evidence(), verification: evidence(), verified: true },
    vulnerabilityReport: { ...evidence(), status: "PASS", critical: 0, high: 0 },
  };
}

function requiredImageIds() {
  return [
    "api",
    "api-migrator",
    "deerflow",
    "export-worker",
    "file-worker",
    "import-worker",
    "preview",
    "quartz",
    "runtime-worker",
    "web",
  ];
}
