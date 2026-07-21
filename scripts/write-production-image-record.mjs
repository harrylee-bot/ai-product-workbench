#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyProductionBuildConfiguration } from "./write-production-build-configuration.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

export function createProductionImageRecord({
  id,
  imageRef,
  digest,
  sourceCommit,
  buildConfigurationPath,
  sbomPath,
  sbomAttestationPath,
  provenancePath,
  signaturePath,
  verificationPath,
  vulnerabilityPath,
}) {
  assert(/^[a-z0-9-]+$/u.test(id), "image id is invalid");
  assert(DIGEST_PATTERN.test(digest), "image digest must be immutable sha256");
  assert(imageRef.endsWith(`@${digest}`), "imageRef must end with the image digest");
  assert(COMMIT_PATTERN.test(sourceCommit), "source commit must be a 40-character lowercase Git SHA");
  const buildConfiguration = JSON.parse(readFileSync(resolve(buildConfigurationPath), "utf8"));
  verifyProductionBuildConfiguration(buildConfiguration, { id, sourceCommit });
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
    buildConfiguration,
    sbom: evidence(sbomPath, "spdx-json"),
    sbomAttestation: evidence(sbomAttestationPath, "signed-sbom-attestation-bundle"),
    provenance: evidence(provenancePath, "signed-provenance-bundle"),
    signature: {
      ...evidence(signaturePath, "cosign-bundle"),
      verification: evidence(verificationPath, "cosign-verify"),
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
  const names = new Map([
    ["--id", "id"],
    ["--image-ref", "imageRef"],
    ["--digest", "digest"],
    ["--source-commit", "sourceCommit"],
    ["--build-configuration-path", "buildConfigurationPath"],
    ["--sbom-path", "sbomPath"],
    ["--sbom-attestation-path", "sbomAttestationPath"],
    ["--provenance-path", "provenancePath"],
    ["--signature-path", "signaturePath"],
    ["--verification-path", "verificationPath"],
    ["--vulnerability-path", "vulnerabilityPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = names.get(argument);
    assert(key, `unsupported argument: ${argument}`);
    result[key] = argv[++index];
  }
  for (const [flag, key] of names) {
    assert(result[key], `${flag} is required`);
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
