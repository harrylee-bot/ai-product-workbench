import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionImageRecord } from "./write-production-image-record.mjs";

test("writes content-addressed evidence and rejects vulnerable images", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-image-record-"));
  const files = {
    sbom: join(directory, "sbom.json"),
    provenance: join(directory, "provenance.json"),
    signature: join(directory, "signature.json"),
    verification: join(directory, "verification.json"),
    vulnerability: join(directory, "trivy.json"),
  };
  writeFileSync(files.sbom, "{}\n");
  writeFileSync(files.provenance, "{}\n");
  writeFileSync(files.signature, "{}\n");
  writeFileSync(files.verification, "{}\n");
  writeFileSync(files.vulnerability, JSON.stringify({ Results: [] }));
  const digest = `sha256:${"a".repeat(64)}`;
  const record = createProductionImageRecord({
    id: "import-worker",
    imageRef: `ghcr.io/example/import-worker@${digest}`,
    digest,
    sourceCommit: "b".repeat(40),
    sbomPath: files.sbom,
    provenancePath: files.provenance,
    signaturePath: files.signature,
    verificationPath: files.verification,
    vulnerabilityPath: files.vulnerability,
  });
  assert.equal(record.signature.verified, true);
  assert.match(record.sbom.uri, /^urn:sha256:[a-f0-9]{64}$/u);

  writeFileSync(files.vulnerability, JSON.stringify({ Results: [{ Vulnerabilities: [{ Severity: "HIGH" }] }] }));
  assert.throws(() => createProductionImageRecord({
    id: "import-worker",
    imageRef: `ghcr.io/example/import-worker@${digest}`,
    digest,
    sourceCommit: "b".repeat(40),
    sbomPath: files.sbom,
    provenancePath: files.provenance,
    signaturePath: files.signature,
    verificationPath: files.verification,
    vulnerabilityPath: files.vulnerability,
  }), /vulnerability scan found/u);
});
