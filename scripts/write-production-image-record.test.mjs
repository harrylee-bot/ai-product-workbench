import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProductionImageRecord } from "./write-production-image-record.mjs";
import { createProductionBuildConfiguration } from "./write-production-build-configuration.mjs";

test("writes content-addressed evidence and rejects vulnerable images", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-image-record-"));
  const files = {
    sbom: join(directory, "sbom.json"),
    sbomAttestation: join(directory, "sbom-attestation.bundle.json"),
    provenance: join(directory, "provenance.json"),
    signature: join(directory, "signature.json"),
    verification: join(directory, "verification.json"),
    vulnerability: join(directory, "trivy.json"),
    buildConfiguration: join(directory, "build-configuration.json"),
  };
  writeFileSync(files.sbom, "{}\n");
  writeFileSync(files.sbomAttestation, "{}\n");
  writeFileSync(files.provenance, "{}\n");
  writeFileSync(files.signature, "{}\n");
  writeFileSync(files.verification, "{}\n");
  writeFileSync(files.vulnerability, JSON.stringify({ Results: [] }));
  writeFileSync(files.buildConfiguration, JSON.stringify(createProductionBuildConfiguration({
    id: "import-worker",
    sourceCommit: "b".repeat(40),
    dockerfile: "apps/workbench-import-worker/Dockerfile",
    target: "runner",
  })));
  const digest = `sha256:${"a".repeat(64)}`;
  const record = createProductionImageRecord({
    id: "import-worker",
    imageRef: `ghcr.io/example/import-worker@${digest}`,
    digest,
    sourceCommit: "b".repeat(40),
    buildConfigurationPath: files.buildConfiguration,
    sbomPath: files.sbom,
    sbomAttestationPath: files.sbomAttestation,
    provenancePath: files.provenance,
    signaturePath: files.signature,
    verificationPath: files.verification,
    vulnerabilityPath: files.vulnerability,
  });
  assert.equal(Object.hasOwn(record.signature, "verified"), false);
  assert.match(record.sbom.uri, /^urn:sha256:[a-f0-9]{64}$/u);
  assert.match(record.sbomAttestation.uri, /^urn:sha256:[a-f0-9]{64}$/u);
  assert.equal(record.buildConfiguration.id, "import-worker");

  const cli = spawnSync(process.execPath, [
    fileURLToPath(new URL("./write-production-image-record.mjs", import.meta.url)),
    "--id", "import-worker",
    "--image-ref", `ghcr.io/example/import-worker@${digest}`,
    "--digest", digest,
    "--source-commit", "b".repeat(40),
    "--build-configuration-path", files.buildConfiguration,
    "--sbom-path", files.sbom,
    "--sbom-attestation-path", files.sbomAttestation,
    "--provenance-path", files.provenance,
    "--signature-path", files.signature,
    "--verification-path", files.verification,
    "--vulnerability-path", files.vulnerability,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).imageRef, `ghcr.io/example/import-worker@${digest}`);

  writeFileSync(files.vulnerability, JSON.stringify({ Results: [{ Vulnerabilities: [{ Severity: "HIGH" }] }] }));
  assert.throws(() => createProductionImageRecord({
    id: "import-worker",
    imageRef: `ghcr.io/example/import-worker@${digest}`,
    digest,
    sourceCommit: "b".repeat(40),
    buildConfigurationPath: files.buildConfiguration,
    sbomPath: files.sbom,
    sbomAttestationPath: files.sbomAttestation,
    provenancePath: files.provenance,
    signaturePath: files.signature,
    verificationPath: files.verification,
    vulnerabilityPath: files.vulnerability,
  }), /vulnerability scan found/u);
});
