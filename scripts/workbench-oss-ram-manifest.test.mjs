import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOssRamManifest } from "./workbench-oss-ram-manifest.mjs";

const bucket = "aionbench-workbench-prod";

test("builds eight independent least-privilege OSS identities", () => {
  const manifest = buildOssRamManifest({ bucket, environment: "prod" });

  assert.equal(manifest.schemaVersion, "workbench.oss-ram-identity-manifest.v1");
  assert.equal(manifest.defaultAuthorization, "deny");
  assert.equal(manifest.identities.length, 8);
  assert.equal(new Set(manifest.identities.map(({ userName }) => userName)).size, 8);
  assert.equal(new Set(manifest.identities.map(({ policyName }) => policyName)).size, 8);
  assert.equal(new Set(manifest.identities.map(({ envPrefix }) => envPrefix)).size, 8);

  for (const identity of manifest.identities) {
    assert.match(identity.userName, /^wb-prod-[a-z-]+$/u);
    assert.match(identity.policyName, /^WorkbenchOss[A-Za-z]+Prod$/u);
    assert.match(identity.policyDocumentSha256, /^[a-f0-9]{64}$/u);
    for (const statement of identity.policyDocument.Statement) {
      assert.equal(statement.Effect, "Allow");
      assert.ok(!statement.Action.includes("oss:*"));
      assert.ok(statement.Resource.every((resource) => (
        resource.startsWith(`acs:oss:*:*:${bucket}/`) && resource.endsWith("/*")
      )));
    }
  }
});

test("maps application operations to exact OSS actions and prefixes", () => {
  const identities = new Map(
    buildOssRamManifest({ bucket, environment: "prod" }).identities
      .map((identity) => [identity.id, identity.policyDocument.Statement]),
  );

  assert.deepEqual(identities.get("api-staging"), [{
    Effect: "Allow",
    Action: ["oss:PutObject", "oss:GetObject", "oss:ListParts", "oss:AbortMultipartUpload"],
    Resource: [`acs:oss:*:*:${bucket}/staging/files/*`],
  }]);
  assert.deepEqual(identities.get("api-ready"), [readerStatement()]);
  assert.deepEqual(identities.get("runtime-ready"), [readerStatement()]);
  assert.deepEqual(identities.get("preview"), [readerStatement()]);
  assert.deepEqual(identities.get("api-canvas"), [{
    Effect: "Allow",
    Action: ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
    Resource: [`acs:oss:*:*:${bucket}/canvas-visuals/*`],
  }]);
  assert.deepEqual(identities.get("file-pipeline"), [
    {
      Effect: "Allow",
      Action: ["oss:GetObject", "oss:DeleteObject"],
      Resource: [`acs:oss:*:*:${bucket}/staging/files/*`],
    },
    {
      Effect: "Allow",
      Action: ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
      Resource: [
        `acs:oss:*:*:${bucket}/pending/blobs/*`,
        `acs:oss:*:*:${bucket}/blobs/*`,
        `acs:oss:*:*:${bucket}/quarantine/blobs/*`,
      ],
    },
  ]);
  assert.deepEqual(identities.get("import"), [{
    Effect: "Allow",
    Action: ["oss:GetObject", "oss:PutObject"],
    Resource: [
      `acs:oss:*:*:${bucket}/pending/imports/*`,
      `acs:oss:*:*:${bucket}/blobs/*`,
    ],
  }]);
  assert.deepEqual(identities.get("export"), [{
    Effect: "Allow",
    Action: ["oss:GetObject", "oss:PutObject", "oss:DeleteObject"],
    Resource: [
      `acs:oss:*:*:${bucket}/pending/exports/*`,
      `acs:oss:*:*:${bucket}/blobs/*`,
    ],
  }]);
});

test("rejects names that could widen an OSS resource", () => {
  for (const candidate of ["AionBench", "aionbench/workbench", "-bucket", "bucket-", "ab", "bucket_1"] ) {
    assert.throws(
      () => buildOssRamManifest({ bucket: candidate, environment: "prod" }),
      /bucket is not a canonical identifier/u,
    );
  }
  for (const candidate of ["Prod", "p", "prod/other", "prod_1", "-prod"]) {
    assert.throws(
      () => buildOssRamManifest({ bucket, environment: candidate }),
      /environment is not a canonical identifier/u,
    );
  }
});

test("CLI output is deterministic and the provisioner fails closed", () => {
  const first = execFileSync(process.execPath, [
    "scripts/workbench-oss-ram-manifest.mjs",
    "--bucket",
    bucket,
  ], { encoding: "utf8" });
  const second = execFileSync(process.execPath, [
    "scripts/workbench-oss-ram-manifest.mjs",
    "--bucket",
    bucket,
  ], { encoding: "utf8" });
  assert.equal(first, second);

  const provisioner = readFileSync("deploy/provision-workbench-oss-ram.sh", "utf8");
  assert.match(provisioner, /set \+x/u);
  assert.match(provisioner, /umask 077/u);
  assert.match(provisioner, /WORKBENCH_OSS_PROVISION_CONFIRM/u);
  for (const requiredSetting of [
    "WORKBENCH_OSS_REGION",
    "WORKBENCH_OSS_INTERNAL_ENDPOINT",
    "WORKBENCH_OSS_EGRESS_UPSTREAM_HOST",
    "WORKBENCH_OSS_BROWSER_UPLOAD_BUCKET_URL",
  ]) {
    assert.match(provisioner, new RegExp(`${requiredSetting} is required`, "u"));
  }
  assert.match(provisioner, /refusing to overwrite existing RAM user/u);
  assert.match(provisioner, /refusing to overwrite existing RAM policy/u);
  assert.match(provisioner, /DeleteAccessKey/u);
  assert.match(provisioner, /rm -f "\$ENV_OUTPUT" "\$EVIDENCE_OUTPUT"/u);
  assert.match(provisioner, /install -m 600/u);
  assert.doesNotMatch(provisioner, /echo .*AccessKeySecret/u);
  assert.doesNotMatch(provisioner, /uploads\.aionbench\.com|oss-cn-hangzhou/u);
});

function readerStatement() {
  return {
    Effect: "Allow",
    Action: ["oss:GetObject"],
    Resource: [`acs:oss:*:*:${bucket}/blobs/*`],
  };
}
