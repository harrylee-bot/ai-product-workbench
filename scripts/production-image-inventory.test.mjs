import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  assembleProductionImageManifest,
  assertPinnedWorkflowActions,
  assertProductionAcceptanceImageWorkflow,
  assertProductionWorkflowPermissions,
  loadProductionImageDigestBinding,
  loadVerifiedProductionImageManifest,
  productionImageDigestBinding,
  verifyCosignManifestBlob,
  verifyLocalProductionImageBindings,
  verifyProductionImageManifest,
  verifyProductionImageSignatureBundles,
} from "./production-image-inventory.mjs";
import { createProductionBuildConfiguration } from "./write-production-build-configuration.mjs";

const commit = "a".repeat(40);
const certificateIdentity = "https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/production";
const certificateOidcIssuer = "https://token.actions.githubusercontent.com";

test("assembles only the exact candidate image inventory", () => {
  const records = requiredImageIds().map(imageRecord);
  const manifest = assembleProductionImageManifest({ records, expectedCommit: commit });
  assert.equal(manifest.images.length, records.length);
  assert(manifest.images.some((entry) => entry.id === "import-worker"));
  assert(manifest.images.some((entry) => entry.id === "deerflow"));
});

test("binds the image manifest to the verified release-chain ID", () => {
  const records = requiredImageIds().map(imageRecord);
  const releaseChainId = `sha256:${"f".repeat(64)}`;
  const manifest = assembleProductionImageManifest({
    records,
    expectedCommit: commit,
    releaseChainId,
  });
  assert.equal(manifest.candidate.releaseChainId, releaseChainId);
  assert.equal(verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    expectedReleaseChainId: releaseChainId,
  }), true);
  assert.throws(
    () => verifyProductionImageManifest({
      manifest,
      expectedCommit: commit,
      expectedReleaseChainId: `sha256:${"0".repeat(64)}`,
    }),
    /release chain ID mismatch/u,
  );
});

test("derives one sorted complete digest binding from the candidate-bound G4 manifest", async (t) => {
  const releaseChainId = `sha256:${"f".repeat(64)}`;
  const manifest = candidateManifest();
  manifest.candidate.releaseChainId = releaseChainId;
  const images = productionImageDigestBinding({
    manifest,
    expectedCommit: commit,
    expectedReleaseChainId: releaseChainId,
  });
  assert.deepEqual(images.map((image) => image.name), requiredImageIds());
  assert.equal(images.length, 10);

  const root = await mkdtemp(path.join(tmpdir(), "workbench-production-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "production-image-manifest.json");
  const raw = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(manifestPath, raw);
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  const loaded = loadProductionImageDigestBinding({
    manifestPath,
    expectedManifestSha256: manifestSha256,
    expectedCommit: commit,
    expectedReleaseChainId: releaseChainId,
  });
  assert.deepEqual(loaded.images, images);
  assert.equal(loaded.manifestSha256, manifestSha256);
  assert.throws(() => loadProductionImageDigestBinding({
    manifestPath,
    expectedManifestSha256: "0".repeat(64),
    expectedCommit: commit,
    expectedReleaseChainId: releaseChainId,
  }), /manifest SHA-256 mismatch/u);

  const incomplete = structuredClone(manifest);
  incomplete.images.pop();
  assert.throws(() => productionImageDigestBinding({
    manifest: incomplete,
    expectedCommit: commit,
    expectedReleaseChainId: releaseChainId,
  }), /exact deploy inventory/u);
});

test("requires every GitHub Action reference to use a full commit SHA", () => {
  assert.equal(assertPinnedWorkflowActions({
    jobs: { build: { steps: [{ uses: "actions/checkout@" + "a".repeat(40) }] } },
  }), true);
  assert.throws(
    () => assertPinnedWorkflowActions({ jobs: { build: { steps: [{ uses: "actions/checkout@v4" }] } } }),
    /full commit SHA/u,
  );
});

test("keeps PR and quality jobs unprivileged and confines token writes to production-only jobs", () => {
  const workflowPath = fileURLToPath(new URL("../.github/workflows/workbench-ci.yml", import.meta.url));
  const workflow = YAML.parse(readFileSync(workflowPath, "utf8"));
  assert.equal(assertProductionWorkflowPermissions(workflow), true);

  const privilegedQuality = structuredClone(workflow);
  privilegedQuality.jobs.quality.permissions = { contents: "read", "id-token": "write" };
  assert.throws(
    () => assertProductionWorkflowPermissions(privilegedQuality),
    /quality must not receive privileged|quality must remain unprivileged/u,
  );

  const unguardedPublisher = structuredClone(workflow);
  delete unguardedPublisher.jobs["production-images"].if;
  assert.throws(
    () => assertProductionWorkflowPermissions(unguardedPublisher),
    /production-only job condition/u,
  );
});

test("production acceptance workflow fails closed without same-run G4 download or release binding", () => {
  const workflowPath = fileURLToPath(new URL("../.github/workflows/workbench-production-acceptance.yml", import.meta.url));
  const workflowSource = readFileSync(workflowPath, "utf8");
  const workflow = YAML.parse(workflowSource);
  assert.equal(assertProductionAcceptanceImageWorkflow({ workflow, workflowSource }), true);

  const missingDownload = structuredClone(workflow);
  missingDownload.jobs["production-acceptance"].steps = missingDownload.jobs["production-acceptance"].steps
    .filter((step) => step.name !== "Download CI-owned production image manifest");
  assert.throws(
    () => assertProductionAcceptanceImageWorkflow({ workflow: missingDownload, workflowSource }),
    /download the G4 image manifest from the selected CI run/u,
  );

  const latestAttempt = structuredClone(workflow);
  const latestAttemptDownload = latestAttempt.jobs["production-acceptance"].steps
    .find((step) => step.name === "Download CI-owned production image manifest");
  latestAttemptDownload.run = latestAttemptDownload.run.replace("-$RELEASE_CHAIN_RUN_ATTEMPT", "");
  assert.throws(
    () => assertProductionAcceptanceImageWorkflow({ workflow: latestAttempt, workflowSource }),
    /selected CI run/u,
  );

  const unbound = structuredClone(workflow);
  const verification = unbound.jobs["production-acceptance"].steps
    .find((step) => step.name === "Verify CI-owned G4 images and bind the control catalog");
  verification.run = verification.run.replace('--release-chain-id "$RELEASE_CHAIN_ID"', "");
  assert.throws(
    () => assertProductionAcceptanceImageWorkflow({ workflow: unbound, workflowSource }),
    /G4 verification is missing --release-chain-id/u,
  );
});

test("verifies the exact manifest blob before reading or parsing it", () => {
  const events = [];
  const manifest = loadVerifiedProductionImageManifest({
    manifestPath: "fixtures/production-image-manifest.json",
    bundlePath: "fixtures/production-image-manifest.bundle.json",
    certificateIdentity,
    certificateOidcIssuer,
    verifyBlob: (input) => {
      events.push("verify");
      assert.match(input.manifestPath, /production-image-manifest\.json$/u);
      assert.match(input.bundlePath, /production-image-manifest\.bundle\.json$/u);
      assert.equal(input.certificateIdentity, certificateIdentity);
      assert.equal(input.certificateOidcIssuer, certificateOidcIssuer);
      return true;
    },
    readManifest: () => {
      events.push("read");
      return JSON.stringify(candidateManifest());
    },
  });
  assert.equal(manifest.candidate.sourceCommit, commit);
  assert.deepEqual(events, ["verify", "read"]);

  let readAttempted = false;
  assert.throws(() => loadVerifiedProductionImageManifest({
    manifestPath: "fixtures/production-image-manifest.json",
    bundlePath: "fixtures/production-image-manifest.bundle.json",
    certificateIdentity,
    certificateOidcIssuer,
    verifyBlob: () => {
      throw new Error("signature rejected");
    },
    readManifest: () => {
      readAttempted = true;
      return "{}";
    },
  }), /signature rejected/u);
  assert.equal(readAttempted, false);
});

test("Cosign manifest verification uses exact identity flags", () => {
  let invocation;
  assert.equal(verifyCosignManifestBlob({
    manifestPath: "/release/production-image-manifest.json",
    bundlePath: "/release/production-image-manifest.bundle.json",
    certificateIdentity,
    certificateOidcIssuer,
    execute: (command, args, options) => {
      invocation = { command, args, options };
    },
  }), true);
  assert.deepEqual(invocation, {
    command: "cosign",
    args: [
      "verify-blob",
      "--bundle", "/release/production-image-manifest.bundle.json",
      "--certificate-identity", certificateIdentity,
      "--certificate-oidc-issuer", certificateOidcIssuer,
      "/release/production-image-manifest.json",
    ],
    options: { stdio: ["ignore", "ignore", "pipe"] },
  });
  assert.throws(() => verifyCosignManifestBlob({
    manifestPath: "/release/production-image-manifest.json",
    bundlePath: "/release/production-image-manifest.bundle.json",
    certificateIdentity,
    certificateOidcIssuer,
    execute: () => {
      throw new Error("invalid signature");
    },
  }), /signature verification failed/u);
});

test("manifest CLI fails closed without signature context and treats assemble as a flag", () => {
  const script = fileURLToPath(new URL("./production-image-inventory.mjs", import.meta.url));
  const missingSignature = spawnSync(process.execPath, [
    script,
    "--manifest", "missing.json",
    "--expected-commit", commit,
  ], { encoding: "utf8" });
  assert.notEqual(missingSignature.status, 0);
  assert.match(missingSignature.stderr, /--bundle is required with --manifest/u);

  const assemble = spawnSync(process.execPath, [
    script,
    "--assemble",
    "--expected-commit", commit,
  ], { encoding: "utf8" });
  assert.notEqual(assemble.status, 0);
  assert.match(assemble.stderr, /at least one --record is required with --assemble/u);
});

test("rejects a missing Import Worker image", () => {
  const manifest = candidateManifest(requiredImageIds().filter((id) => id !== "import-worker"));
  assert.throws(
    () => verifyProductionImageManifest({ manifest, expectedCommit: commit }),
    /exact deploy inventory/u,
  );
});

test("requires complete Import Worker evidence and its exact deployed digest", () => {
  const manifest = candidateManifest();
  const importWorker = manifest.images.find((entry) => entry.id === "import-worker");
  const deploymentEnvironment = new Map([
    ["WORKBENCH_IMPORT_WORKER_IMAGE_REF", importWorker.imageRef],
    ["WORKBENCH_NODE_IMAGE", `node:22-alpine@sha256:${"a".repeat(64)}`],
  ]);

  assert.equal(verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    deploymentEnvironment,
    onlyImageId: "import-worker",
  }), true);

  for (const field of [
    "sbom",
    "sbomAttestation",
    "provenance",
    "signature",
    "vulnerabilityReport",
  ]) {
    const incomplete = structuredClone(manifest);
    delete incomplete.images.find((entry) => entry.id === "import-worker")[field];
    assert.throws(
      () => verifyProductionImageManifest({
        manifest: incomplete,
        expectedCommit: commit,
        onlyImageId: "import-worker",
      }),
      /evidence is required/u,
      `Import Worker must reject missing ${field} evidence`,
    );
  }

  deploymentEnvironment.set(
    "WORKBENCH_IMPORT_WORKER_IMAGE_REF",
    `registry.example.test/workbench/import-worker@sha256:${"f".repeat(64)}`,
  );
  assert.throws(
    () => verifyProductionImageManifest({
      manifest,
      expectedCommit: commit,
      deploymentEnvironment,
      onlyImageId: "import-worker",
    }),
    /WORKBENCH_IMPORT_WORKER_IMAGE_REF does not match signed image evidence/u,
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

test("does not treat a record-owned signature.verified boolean as trusted evidence", () => {
  const manifest = candidateManifest();
  manifest.images[0].signature.verified = false;
  assert.equal(verifyProductionImageManifest({ manifest, expectedCommit: commit }), true);
  manifest.images[0].signature.verified = true;
  assert.equal(verifyProductionImageManifest({ manifest, expectedCommit: commit }), true);
});

test("G12 verifies all ten exact image subjects against their content-addressed Cosign bundles", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-image-signatures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = candidateManifest();
  manifest.candidate.releaseChainId = `sha256:${"f".repeat(64)}`;
  for (const record of manifest.images) {
    const bytes = Buffer.from(`${JSON.stringify({ imageRef: record.imageRef })}\n`);
    const bundlePath = path.join(root, `cosign-${record.id}.bundle.json`);
    await writeFile(bundlePath, bytes);
    record.signature.sha256 = createHash("sha256").update(bytes).digest("hex");
    record.signature.uri = `urn:sha256:${record.signature.sha256}`;
  }
  const invocations = [];
  assert.equal(verifyProductionImageSignatureBundles({
    manifest,
    signatureBundleRoot: root,
    certificateIdentity,
    certificateOidcIssuer,
    expectedCommit: commit,
    expectedReleaseChainId: manifest.candidate.releaseChainId,
    execute: (command, args, options) => invocations.push({ command, args, options }),
  }), true);
  assert.equal(invocations.length, 10);
  for (const [index, invocation] of invocations.entries()) {
    const record = manifest.images[index];
    assert.equal(invocation.command, "cosign");
    assert.deepEqual(invocation.args, [
      "verify",
      "--bundle", path.join(root, `cosign-${record.id}.bundle.json`),
      "--certificate-identity", certificateIdentity,
      "--certificate-oidc-issuer", certificateOidcIssuer,
      record.imageRef,
    ]);
  }

  await writeFile(path.join(root, `cosign-${manifest.images[0].id}.bundle.json`), "forged\n");
  assert.throws(() => verifyProductionImageSignatureBundles({
    manifest,
    signatureBundleRoot: root,
    certificateIdentity,
    certificateOidcIssuer,
    expectedCommit: commit,
    expectedReleaseChainId: manifest.candidate.releaseChainId,
    execute: () => undefined,
  }), /Cosign bundle SHA-256 mismatch/u);
});

test("rejects scan findings", () => {
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

test("binds the DeerFlow Validator Node image to the deployment environment", () => {
  const manifest = candidateManifest();
  const deerflow = manifest.images.find((entry) => entry.id === "deerflow");
  const deploymentEnvironment = new Map([
    ["WORKBENCH_DEERFLOW_IMAGE_REF", deerflow.imageRef],
    ["WORKBENCH_DEERFLOW_BASE_IMAGE_REF", `registry.example.test/deerflow@sha256:${"f".repeat(64)}`],
    ["WORKBENCH_DEERFLOW_NODE_IMAGE_REF", `node:22-bookworm-slim@sha256:${"9".repeat(64)}`],
    ["WORKBENCH_DEERFLOW_COMMIT", "d".repeat(40)],
  ]);
  assert.equal(verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    deploymentEnvironment,
    onlyImageId: "deerflow",
  }), true);

  deploymentEnvironment.delete("WORKBENCH_DEERFLOW_NODE_IMAGE_REF");
  assert.throws(() => verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    deploymentEnvironment,
    onlyImageId: "deerflow",
  }), /requires WORKBENCH_DEERFLOW_NODE_IMAGE_REF/u);
  deploymentEnvironment.set(
    "WORKBENCH_DEERFLOW_NODE_IMAGE_REF",
    `node:22-bookworm-slim@sha256:${"9".repeat(64)}`,
  );

  deploymentEnvironment.set(
    "WORKBENCH_DEERFLOW_NODE_IMAGE_REF",
    `node:22-bookworm-slim@sha256:${"8".repeat(64)}`,
  );
  assert.throws(() => verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    deploymentEnvironment,
    onlyImageId: "deerflow",
  }), /does not match the deployment environment/u);
});

test("keeps the exact previous DeerFlow candidate available for rollback", () => {
  const legacyCommit = "4bf8c155678f2b5baf0ab42e938cfbeca09abdf1";
  const manifest = candidateManifest(["deerflow"]);
  const deerflow = manifest.images[0];
  manifest.candidate.sourceCommit = legacyCommit;
  deerflow.sourceCommit = legacyCommit;
  deerflow.buildConfiguration = createProductionBuildConfiguration({
    id: "deerflow",
    sourceCommit: legacyCommit,
    dockerfile: "integrations/deerflow/Dockerfile",
    target: "runtime",
    buildArgsSource: [
      `DEERFLOW_BASE_IMAGE=registry.example.test/deerflow@sha256:${"f".repeat(64)}`,
      `DEERFLOW_SOURCE_COMMIT=${"d".repeat(40)}`,
      `WORKBENCH_SOURCE_COMMIT=${legacyCommit}`,
    ].join("\n"),
  });
  const deploymentEnvironment = new Map([
    ["WORKBENCH_DEERFLOW_IMAGE_REF", deerflow.imageRef],
    ["WORKBENCH_DEERFLOW_BASE_IMAGE_REF", `registry.example.test/deerflow@sha256:${"f".repeat(64)}`],
    ["WORKBENCH_DEERFLOW_COMMIT", "d".repeat(40)],
  ]);

  assert.equal(verifyProductionImageManifest({
    manifest,
    expectedCommit: legacyCommit,
    deploymentEnvironment,
    onlyImageId: "deerflow",
  }), true);
});

test("binds inspected image labels to source and canonical build configuration", () => {
  const manifest = candidateManifest();
  const labelsFor = (record) => ({
    "org.opencontainers.image.revision": commit,
    "io.workbench.build-configuration-sha256": record.buildConfiguration.payloadSha256,
  });
  const records = new Map(manifest.images.map((record) => [record.imageRef, record]));
  assert.equal(verifyLocalProductionImageBindings({
    manifest,
    expectedCommit: commit,
    inspectImage: (imageRef) => labelsFor(records.get(imageRef)),
  }), true);

  assert.throws(() => verifyLocalProductionImageBindings({
    manifest,
    expectedCommit: commit,
    onlyImageId: "web",
    inspectImage: () => ({
      "org.opencontainers.image.revision": commit,
      "io.workbench.build-configuration-sha256": "0".repeat(64),
    }),
  }), /build configuration label mismatch/u);
});

test("rejects a Web image compiled for origins outside the deployment environment", () => {
  const manifest = candidateManifest();
  const web = manifest.images.find((entry) => entry.id === "web");
  web.buildConfiguration = createProductionBuildConfiguration({
    id: "web",
    sourceCommit: commit,
    dockerfile: "apps/web/Dockerfile",
    target: "runner",
    buildArgsSource: [
      "NEXT_PUBLIC_KNOWLEDGE_APP_URL=https://workbench.example.test/knowledge",
      "NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL=",
      "NEXT_PUBLIC_WORKBENCH_FORUM_URL=",
      "NEXT_PUBLIC_WORKBENCH_PRIVACY_URL=",
      "NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED=false",
      `NODE_IMAGE=node:22-alpine@sha256:${"a".repeat(64)}`,
      "WORKBENCH_PREVIEW_ORIGIN=https://preview.workbench.example.test",
      "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=https://uploads.workbench.example.test/workbench",
    ].join("\n"),
  });
  const deploymentEnvironment = new Map([
    ["WORKBENCH_WEB_IMAGE_REF", web.imageRef],
    ["WORKBENCH_KNOWLEDGE_BASE_URL", "workbench.example.test/knowledge"],
    ["WORKBENCH_PUBLIC_REGISTRATION_ENABLED", "false"],
    ["WORKBENCH_PREVIEW_ORIGIN", "https://preview.workbench.example.test"],
    ["WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL", "https://uploads.workbench.example.test/workbench"],
    ["WORKBENCH_NODE_IMAGE", `node:22-alpine@sha256:${"a".repeat(64)}`],
  ]);
  assert.equal(verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    deploymentEnvironment,
    onlyImageId: "web",
  }), true);

  deploymentEnvironment.set("WORKBENCH_PREVIEW_ORIGIN", "https://preview.other.test");
  assert.throws(() => verifyProductionImageManifest({
    manifest,
    expectedCommit: commit,
    deploymentEnvironment,
    onlyImageId: "web",
  }), /does not match the deployment environment/u);
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
    buildConfiguration: buildConfiguration(id),
    sbom: evidence(),
    sbomAttestation: evidence(),
    provenance: evidence(),
    signature: { ...evidence(), verification: evidence(), verified: true },
    vulnerabilityReport: { ...evidence(), status: "PASS", critical: 0, high: 0 },
  };
}

function buildConfiguration(id) {
  const definitions = {
    api: ["apps/workbench-api/Dockerfile", "runner"],
    "api-migrator": ["apps/workbench-api/Dockerfile", "migrator"],
    deerflow: ["integrations/deerflow/Dockerfile", "runtime"],
    "export-worker": ["apps/workbench-export-worker/Dockerfile", "runner"],
    "file-worker": ["apps/workbench-file-worker/Dockerfile", "runner"],
    "import-worker": ["apps/workbench-import-worker/Dockerfile", "runner"],
    preview: ["apps/workbench-preview/Dockerfile", "runner"],
    quartz: ["apps/knowledge/Dockerfile", "immutable-runner"],
    "runtime-worker": ["apps/workbench-worker/Dockerfile", "runner"],
    web: ["apps/web/Dockerfile", "runner"],
  };
  const [dockerfile, target] = definitions[id];
  const buildArgsSource = id === "deerflow"
    ? `DEERFLOW_BASE_IMAGE=registry.example.test/deerflow@sha256:${"f".repeat(64)}\nDEERFLOW_NODE_IMAGE=node:22-bookworm-slim@sha256:${"9".repeat(64)}\nDEERFLOW_SOURCE_COMMIT=${"d".repeat(40)}\nWORKBENCH_SOURCE_COMMIT=${commit}`
    : id === "web"
      ? [
        "NEXT_PUBLIC_KNOWLEDGE_APP_URL=https://workbench.example.test/knowledge",
        "NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL=",
        "NEXT_PUBLIC_WORKBENCH_FORUM_URL=",
        "NEXT_PUBLIC_WORKBENCH_PRIVACY_URL=",
        "NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED=false",
        `NODE_IMAGE=node:22-alpine@sha256:${"a".repeat(64)}`,
        "WORKBENCH_PREVIEW_ORIGIN=https://preview.workbench.example.test",
        "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL=https://uploads.workbench.example.test/workbench",
      ].join("\n")
      : id === "quartz"
        ? `KNOWLEDGE_WEB_URL=https://workbench.example.test\nNGINX_IMAGE=nginx:stable-alpine@sha256:${"b".repeat(64)}\nNODE_IMAGE=node:22-alpine@sha256:${"a".repeat(64)}\nQUARTZ_BASE_URL=workbench.example.test/knowledge`
        : ["api", "api-migrator", "runtime-worker", "file-worker", "import-worker", "export-worker", "preview"].includes(id)
          ? `NODE_IMAGE=node:22-alpine@sha256:${"a".repeat(64)}`
          : "";
  return createProductionBuildConfiguration({ id, sourceCommit: commit, dockerfile, target, buildArgsSource });
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
