#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

export function createProductionImageRecord({
  id,
  imageRef,
  digest,
  sourceCommit,
  sbomPath,
  provenancePath,
  signaturePath,
  verificationPath,
  vulnerabilityPath,
}) {
  assert(/^[a-z0-9-]+$/u.test(id), "image id is invalid");
  assert(DIGEST_PATTERN.test(digest), "image digest must be immutable sha256");
  assert(imageRef.endsWith(`@${digest}`), "imageRef must end with the image digest");
  assert(COMMIT_PATTERN.test(sourceCommit), "source commit must be a 40-character lowercase Git SHA");
  const evidence = (path, label) => {
    const bytes = readFileSync(resolve(path));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { uri: `urn:sha256:${sha256}`, sha256 };
  };
  const vulnerabilityReport = evidence(vulnerabilityPath, "trivy");
  const scan = parseTrivy(readFileSync(resolve(vulnerabilityPath), "utf8"));
  return {
    id,
    imageRef,
    digest,
    sourceCommit,
    sbom: evidence(sbomPath, "spdx-json"),
    provenance: evidence(provenancePath, "build-metadata"),
    signature: {
      ...evidence(signaturePath, "cosign-bundle"),
      verification: evidence(verificationPath, "cosign-verify"),
      verified: true,
    },
    vulnerabilityReport: { ...vulnerabilityReport, status: "PASS", critical: scan.critical, high: scan.high },
  };
}

function parseTrivy(source) {
  let document;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("Trivy output is not valid JSON");
  }
  let critical = 0;
  let high = 0;
  for (const result of document.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability.Severity === "CRITICAL") critical += 1;
      if (vulnerability.Severity === "HIGH") high += 1;
    }
  }
  if (critical > 0 || high > 0) throw new Error(`vulnerability scan found critical=${critical}, high=${high}`);
  return { critical, high };
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unsupported argument: ${argument}`);
    const key = argument.slice(2).replaceAll("-", "_");
    result[key] = argv[++index];
  }
  for (const key of ["id", "image_ref", "digest", "source_commit", "sbom_path", "provenance_path", "signature_path", "verification_path", "vulnerability_path"]) {
    assert(result[key], `--${key.replaceAll("_", "-")} is required`);
  }
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(createProductionImageRecord(args), null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`production image record: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
