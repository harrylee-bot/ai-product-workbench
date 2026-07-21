#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET_PATTERN = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/u;
const ENVIRONMENT_PATTERN = /^(?=.{2,16}$)[a-z][a-z0-9-]*[a-z0-9]$/u;

const ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "api-staging",
    policyStem: "ApiStaging",
    envPrefix: "WORKBENCH_API_STAGING_S3",
    description: "Workbench API multipart staging identity",
    statements: Object.freeze([
      statement(
        ["oss:PutObject", "oss:GetObject", "oss:ListParts", "oss:AbortMultipartUpload"],
        ["staging/files"],
      ),
    ]),
  }),
  readyReader("api-ready", "ApiReady", "WORKBENCH_API_READY_BLOB_S3", "Workbench API ready Blob reader"),
  Object.freeze({
    id: "api-canvas",
    policyStem: "ApiCanvas",
    envPrefix: "WORKBENCH_API_CANVAS_VISUAL_S3",
    description: "Workbench API Canvas visual identity",
    statements: Object.freeze([
      statement(["oss:GetObject", "oss:PutObject", "oss:DeleteObject"], ["canvas-visuals"]),
    ]),
  }),
  readyReader(
    "runtime-ready",
    "RuntimeReady",
    "WORKBENCH_RUNTIME_READY_BLOB_S3",
    "Workbench Runtime ready Blob reader",
  ),
  Object.freeze({
    id: "file-pipeline",
    policyStem: "FilePipeline",
    envPrefix: "WORKBENCH_FILE_PIPELINE_S3",
    description: "Workbench File pipeline identity",
    statements: Object.freeze([
      statement(["oss:GetObject", "oss:DeleteObject"], ["staging/files"]),
      statement(
        ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
        ["pending/blobs", "blobs", "quarantine/blobs"],
      ),
    ]),
  }),
  Object.freeze({
    id: "import",
    policyStem: "Import",
    envPrefix: "WORKBENCH_IMPORT_S3",
    description: "Workbench Import Worker identity",
    statements: Object.freeze([
      statement(["oss:GetObject", "oss:PutObject"], ["pending/imports", "blobs"]),
    ]),
  }),
  Object.freeze({
    id: "export",
    policyStem: "Export",
    envPrefix: "WORKBENCH_EXPORT_S3",
    description: "Workbench Export Worker identity",
    statements: Object.freeze([
      statement(
        ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
        ["pending/exports", "blobs"],
      ),
    ]),
  }),
  readyReader("preview", "Preview", "WORKBENCH_PREVIEW_S3", "Workbench Preview ready Blob reader"),
]);

export function buildOssRamManifest({ bucket, environment }) {
  assertIdentifier(bucket, "bucket", BUCKET_PATTERN);
  assertIdentifier(environment, "environment", ENVIRONMENT_PATTERN);
  const environmentTitle = environment
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");

  const identities = ROLE_DEFINITIONS.map((definition) => {
    const policyDocument = {
      Version: "1",
      Statement: definition.statements.map(({ actions, prefixes }) => ({
        Effect: "Allow",
        Action: [...actions],
        Resource: prefixes.map((prefix) => `acs:oss:*:*:${bucket}/${prefix}/*`),
      })),
    };
    return Object.freeze({
      id: definition.id,
      userName: `wb-${environment}-${definition.id}`,
      policyName: `WorkbenchOss${definition.policyStem}${environmentTitle}`,
      envPrefix: definition.envPrefix,
      description: `${definition.description} (${environment})`,
      policyDocument,
      policyDocumentSha256: createHash("sha256")
        .update(JSON.stringify(policyDocument))
        .digest("hex"),
    });
  });

  return Object.freeze({
    schemaVersion: "workbench.oss-ram-identity-manifest.v1",
    provider: "aliyun-oss",
    bucket,
    environment,
    defaultAuthorization: "deny",
    identities,
  });
}

function statement(actions, prefixes) {
  return Object.freeze({
    actions: Object.freeze(actions),
    prefixes: Object.freeze(prefixes),
  });
}

function readyReader(id, policyStem, envPrefix, description) {
  return Object.freeze({
    id,
    policyStem,
    envPrefix,
    description,
    statements: Object.freeze([statement(["oss:GetObject"], ["blobs"])]),
  });
}

function assertIdentifier(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is not a canonical identifier`);
  }
}

function parseArguments(argv) {
  const result = { environment: "prod" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bucket") result.bucket = argv[++index];
    else if (argument === "--environment") result.environment = argv[++index];
    else throw new Error(`unsupported argument: ${argument}`);
  }
  if (!result.bucket) throw new Error("--bucket is required");
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(buildOssRamManifest(args), null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`workbench OSS RAM manifest: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
