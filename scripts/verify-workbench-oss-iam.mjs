#!/usr/bin/env node

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";

const ROLE_PREFIXES = Object.freeze({
  "api-staging": "WORKBENCH_API_STAGING_S3",
  "api-ready": "WORKBENCH_API_READY_BLOB_S3",
  "api-canvas": "WORKBENCH_API_CANVAS_VISUAL_S3",
  "runtime-ready": "WORKBENCH_RUNTIME_READY_BLOB_S3",
  "file-pipeline": "WORKBENCH_FILE_PIPELINE_S3",
  import: "WORKBENCH_IMPORT_S3",
  export: "WORKBENCH_EXPORT_S3",
  preview: "WORKBENCH_PREVIEW_S3",
});

const checks = [];
const cleanupKeys = new Set();
const openUploads = [];
let activeCheck = "configuration";

async function main() {
  const startedAt = new Date().toISOString();
  const runId = `iam-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const bucket = required("WORKBENCH_S3_BUCKET");
  const region = required("WORKBENCH_S3_REGION");
  const endpoint = canonicalUrl(required("WORKBENCH_S3_INTERNAL_ENDPOINT"), "internal endpoint");
  const browserBucketUrl = canonicalUrl(
    required("WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL"),
    "browser upload bucket URL",
  );
  const webOrigin = canonicalOrigin(required("WORKBENCH_OSS_WEB_ORIGIN"));
  const evidenceOutput = required("WORKBENCH_OSS_VERIFICATION_EVIDENCE_OUTPUT");
  const forcePathStyle = strictBoolean(required("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE"));
  const admin = createClient({
    region,
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: required("ALIBABACLOUD_ACCESS_KEY_ID"),
      secretAccessKey: required("ALIBABACLOUD_ACCESS_KEY_SECRET"),
    },
  });
  const clients = Object.fromEntries(Object.entries(ROLE_PREFIXES).map(([role, prefix]) => [
    role,
    createClient({ region, endpoint, forcePathStyle, credentials: roleCredentials(prefix) }),
  ]));
  const keys = verificationKeys(runId);
  for (const value of Object.values(keys)) {
    if (typeof value === "string") cleanupKeys.add(value);
    else Object.values(value).forEach((key) => cleanupKeys.add(key));
  }

  let failure = null;
  let cleanup = { result: "pending" };
  try {
    await seedObjects(admin, bucket, keys);
    await waitForRolePropagation(clients, bucket, keys);
    await verifyMultipart({
      client: clients["api-staging"],
      browserBucketUrl,
      bucket,
      key: keys.multipart,
      region,
      webOrigin,
    });
    await expectDenied("api-staging.delete", () => clients["api-staging"].send(
      new DeleteObjectCommand({ Bucket: bucket, Key: keys.multipart }),
    ));
    await expectDenied("api-staging.cross-prefix-write", () => clients["api-staging"].send(
      new PutObjectCommand({ Bucket: bucket, Key: keys.canvasDenied, Body: "denied" }),
    ));

    await readAllowed("api-ready.read", clients["api-ready"], bucket, keys.ready);
    await readerDenials("api-ready", clients["api-ready"], bucket, keys);
    await readAllowed("runtime-ready.read", clients["runtime-ready"], bucket, keys.ready);
    await readerDenials("runtime-ready", clients["runtime-ready"], bucket, keys);
    await readAllowed("preview.read", clients.preview, bucket, keys.ready);
    await readerDenials("preview", clients.preview, bucket, keys);

    await putGetDeleteAllowed("api-canvas.crud", clients["api-canvas"], bucket, keys.canvas);
    await expectDenied("api-canvas.cross-prefix-write", () => clients["api-canvas"].send(
      new PutObjectCommand({ Bucket: bucket, Key: keys.blobCanvasDenied, Body: "denied" }),
    ));

    await readAllowed("file-pipeline.staging-read", clients["file-pipeline"], bucket, keys.pipelineStaging);
    await allowed("file-pipeline.staging-delete", () => clients["file-pipeline"].send(
      new DeleteObjectCommand({ Bucket: bucket, Key: keys.pipelineStaging }),
    ));
    await putGetDeleteAllowed(
      "file-pipeline.pending-crud",
      clients["file-pipeline"],
      bucket,
      keys.pendingBlob,
    );
    await putGetDeleteAllowed(
      "file-pipeline.ready-crud",
      clients["file-pipeline"],
      bucket,
      keys.pipelineBlob,
    );
    await putGetDeleteAllowed(
      "file-pipeline.quarantine-crud",
      clients["file-pipeline"],
      bucket,
      keys.quarantine,
    );
    await verifyOssConditionalCreate(
      "file-pipeline.conditional-create",
      clients["file-pipeline"],
      bucket,
      keys.pipelineConditional,
    );
    await expectDenied("file-pipeline.cross-prefix-write", () => clients["file-pipeline"].send(
      new PutObjectCommand({ Bucket: bucket, Key: keys.importDenied, Body: "denied" }),
    ));

    await putGetAllowed("import.pending-write-read", clients.import, bucket, keys.importPending);
    await putGetAllowed("import.ready-write-read", clients.import, bucket, keys.importBlob);
    await verifyOssConditionalCreate(
      "import.conditional-create",
      clients.import,
      bucket,
      keys.importConditional,
    );
    await expectDenied("import.delete", () => clients.import.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: keys.importPending }),
    ));
    await expectDenied("import.cross-prefix-write", () => clients.import.send(
      new PutObjectCommand({ Bucket: bucket, Key: keys.exportDenied, Body: "denied" }),
    ));

    await putGetDeleteAllowed("export.pending-crud", clients.export, bucket, keys.exportPending);
    await putGetDeleteAllowed("export.ready-crud", clients.export, bucket, keys.exportBlob);
    await verifyOssConditionalCreate(
      "export.conditional-create",
      clients.export,
      bucket,
      keys.exportConditional,
    );
    await expectDenied("export.cross-prefix-write", () => clients.export.send(
      new PutObjectCommand({ Bucket: bucket, Key: keys.importExportDenied, Body: "denied" }),
    ));

    for (const [role, client] of Object.entries(clients)) {
      await expectDenied(`${role}.bucket-list`, () => client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "",
        MaxKeys: 1,
      })));
    }
  } catch (error) {
    failure = safeFailure(error, activeCheck);
  } finally {
    try {
      await cleanupVerificationObjects(admin, bucket);
      cleanup = { result: "passed", objectCount: cleanupKeys.size };
    } catch (error) {
      cleanup = { result: "failed", ...safeFailure(error, "cleanup") };
      failure ??= safeFailure(error, "cleanup");
    }
    for (const client of [admin, ...Object.values(clients)]) client.destroy();
  }

  const evidence = {
    schemaVersion: "workbench.oss-iam-verification.v1",
    startedAt,
    completedAt: new Date().toISOString(),
    runId,
    target: {
      bucket,
      region,
      endpointHost: new URL(endpoint).host,
      browserUploadHost: new URL(browserBucketUrl).host,
      webOrigin,
    },
    roleCount: Object.keys(ROLE_PREFIXES).length,
    result: failure ? "failed" : "passed",
    checks,
    cleanup,
    ...(failure ? { failure } : {}),
  };
  writeEvidence(evidenceOutput, evidence);
  if (failure) throw new Error(`OSS IAM verification failed at ${failure.check}: ${failure.code}`);
  process.stdout.write(`OSS IAM verification passed: ${checks.length} checks; evidence written mode 0600\n`);
}

async function seedObjects(admin, bucket, keys) {
  await allowed("admin.seed", async () => {
    for (const key of [keys.ready, keys.pipelineStaging]) {
      await admin.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: `seed:${key}` }));
    }
  });
}

async function waitForRolePropagation(clients, bucket, keys) {
  await eventuallyAllowed("api-staging.policy-active", () => clients["api-staging"].send(
    new HeadObjectCommand({ Bucket: bucket, Key: keys.pipelineStaging }),
  ));
  await eventuallyAllowed("api-ready.policy-active", () => clients["api-ready"].send(
    new HeadObjectCommand({ Bucket: bucket, Key: keys.ready }),
  ));
  await eventuallyAllowed("runtime-ready.policy-active", () => clients["runtime-ready"].send(
    new HeadObjectCommand({ Bucket: bucket, Key: keys.ready }),
  ));
  await eventuallyAllowed("preview.policy-active", () => clients.preview.send(
    new HeadObjectCommand({ Bucket: bucket, Key: keys.ready }),
  ));
  await eventuallyAllowed("api-canvas.policy-active", () => clients["api-canvas"].send(
    new PutObjectCommand({ Bucket: bucket, Key: keys.canvasWarmup, Body: "warmup" }),
  ));
  await eventuallyAllowed("file-pipeline.policy-active", () => clients["file-pipeline"].send(
    new HeadObjectCommand({ Bucket: bucket, Key: keys.pipelineStaging }),
  ));
  await eventuallyAllowed("import.policy-active", () => clients.import.send(
    new PutObjectCommand({ Bucket: bucket, Key: keys.importWarmup, Body: "warmup" }),
  ));
  await eventuallyAllowed("export.policy-active", () => clients.export.send(
    new PutObjectCommand({ Bucket: bucket, Key: keys.exportWarmup, Body: "warmup" }),
  ));
}

async function verifyMultipart({ client, browserBucketUrl, bucket, key, region, webOrigin }) {
  const body = Buffer.from("workbench-browser-multipart-verification", "utf8");
  let created;
  await allowed("api-staging.create-multipart", async () => {
    created = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "text/plain",
      Metadata: { verification: "oss-iam" },
    }));
  });
  if (!created.UploadId) throw verificationError("MULTIPART_UPLOAD_ID_MISSING");
  const upload = { client, key, uploadId: created.UploadId };
  openUploads.push(upload);

  const preflightUrl = objectUrl(browserBucketUrl, key);
  await allowed("browser.cors-preflight", async () => {
    const response = await fetch(preflightUrl, {
      method: "OPTIONS",
      headers: {
        Origin: webOrigin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    if (!response.ok) throw verificationError(`CORS_PREFLIGHT_HTTP_${response.status}`);
    assertCorsOrigin(response, webOrigin);
    if (!headerTokens(response, "access-control-allow-methods").includes("PUT")) {
      throw verificationError("CORS_PUT_NOT_ALLOWED");
    }
  });

  const browserClient = new S3Client({
    region,
    bucketEndpoint: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: client.config.credentials,
  });
  let signedUrl;
  try {
    signedUrl = await getSignedUrl(browserClient, new UploadPartCommand({
      Bucket: browserBucketUrl,
      Key: key,
      UploadId: created.UploadId,
      PartNumber: 1,
      ContentLength: body.byteLength,
    }), { expiresIn: 600 });
  } finally {
    browserClient.destroy();
  }
  const parsedSignedUrl = new URL(signedUrl);
  if (parsedSignedUrl.origin !== new URL(browserBucketUrl).origin) {
    throw verificationError("SIGNED_URL_ORIGIN_MISMATCH");
  }
  if (decodeURIComponent(parsedSignedUrl.pathname) !== `/${key}`) {
    throw verificationError("SIGNED_URL_PATH_MISMATCH");
  }

  let etag;
  await allowed("browser.signed-part-upload", async () => {
    const response = await fetch(signedUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(body.byteLength),
        Origin: webOrigin,
      },
      body,
    });
    if (!response.ok) throw verificationError(`SIGNED_UPLOAD_HTTP_${response.status}`);
    assertCorsOrigin(response, webOrigin);
    if (!headerTokens(response, "access-control-expose-headers").includes("ETAG")) {
      throw verificationError("CORS_ETAG_NOT_EXPOSED");
    }
    etag = response.headers.get("etag") ?? undefined;
    if (!etag) throw verificationError("MULTIPART_ETAG_MISSING");
  });

  await allowed("api-staging.list-parts", async () => {
    const result = await client.send(new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: created.UploadId,
    }));
    if (result.Parts?.length !== 1 || result.Parts[0]?.PartNumber !== 1) {
      throw verificationError("MULTIPART_PART_LIST_MISMATCH");
    }
  });
  await allowed("api-staging.complete-multipart", () => client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: created.UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
    }),
  ));
  openUploads.splice(openUploads.indexOf(upload), 1);
  await allowed("api-staging.head-completed", async () => {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (result.ContentLength !== body.byteLength) throw verificationError("MULTIPART_SIZE_MISMATCH");
  });

  const abortKey = `${key}-abort`;
  cleanupKeys.add(abortKey);
  let abortCreated;
  await allowed("api-staging.create-abortable-multipart", async () => {
    abortCreated = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: abortKey }));
  });
  if (!abortCreated.UploadId) throw verificationError("ABORT_UPLOAD_ID_MISSING");
  const abortUpload = { client, key: abortKey, uploadId: abortCreated.UploadId };
  openUploads.push(abortUpload);
  await allowed("api-staging.abort-multipart", () => client.send(new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: abortKey,
    UploadId: abortCreated.UploadId,
  })));
  openUploads.splice(openUploads.indexOf(abortUpload), 1);
}

async function readerDenials(role, client, bucket, keys) {
  await expectDenied(`${role}.write`, () => client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: keys.readerWriteDenied[role],
    Body: "denied",
  })));
  await expectDenied(`${role}.cross-prefix-read`, () => client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: keys.pipelineStaging,
  })));
}

async function readAllowed(name, client, bucket, key) {
  await allowed(name, async () => {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await consumeBody(result.Body);
  });
}

async function putGetAllowed(name, client, bucket, key) {
  await allowed(name, async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: `verify:${key}` }));
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await consumeBody(result.Body);
  });
}

async function putGetDeleteAllowed(name, client, bucket, key) {
  await allowed(name, async () => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: `verify:${key}` }));
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await consumeBody(result.Body);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });
}

async function verifyOssConditionalCreate(name, client, bucket, key) {
  const original = Buffer.from(`original:${key}`, "utf8");
  const replacement = Buffer.from(`replacement:${key}`, "utf8");
  await allowed(`${name}.first-write`, () => sendOssCreateOnly(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: original }),
  ));
  await expectOssObjectAlreadyExists(`${name}.duplicate-write`, () => sendOssCreateOnly(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: replacement }),
  ));
  await allowed(`${name}.identity-preserved`, async () => {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const stored = await bodyBytes(result.Body);
    if (!stored.equals(original)) throw verificationError("CONDITIONAL_CREATE_IDENTITY_CHANGED");
  });
}

function sendOssCreateOnly(client, command) {
  command.middlewareStack.add(
    (next) => async (arguments_) => {
      if (!arguments_.request || typeof arguments_.request !== "object") {
        throw verificationError("OSS_HTTP_REQUEST_UNAVAILABLE");
      }
      const headers = arguments_.request.headers;
      if (!headers || typeof headers !== "object") {
        throw verificationError("OSS_HTTP_HEADERS_UNAVAILABLE");
      }
      headers["x-oss-forbid-overwrite"] = "true";
      return next(arguments_);
    },
    { step: "build", name: "workbenchOssForbidOverwrite", priority: "low" },
  );
  return client.send(command);
}

async function allowed(name, operation) {
  activeCheck = name;
  await operation();
  checks.push({ name, expectation: "allow", result: "passed" });
}

async function eventuallyAllowed(name, operation) {
  activeCheck = name;
  const deadline = Date.now() + 120_000;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await operation();
      checks.push({ name, expectation: "allow", result: "passed", attempts });
      return;
    } catch (error) {
      if (!isAccessDenied(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function expectDenied(name, operation) {
  activeCheck = name;
  try {
    await operation();
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    checks.push({ name, expectation: "deny", result: "passed" });
    return;
  }
  throw verificationError("EXPECTED_ACCESS_DENIED");
}

async function expectOssObjectAlreadyExists(name, operation) {
  activeCheck = name;
  try {
    await operation();
  } catch (error) {
    const candidate = error && typeof error === "object" ? error : {};
    const code = candidate.name ?? candidate.Code ?? candidate.code;
    if (code === "FileAlreadyExists" && candidate.$metadata?.httpStatusCode === 409) {
      checks.push({ name, expectation: "FileAlreadyExists/409", result: "passed" });
      return;
    }
    throw error;
  }
  throw verificationError("EXPECTED_FILE_ALREADY_EXISTS");
}

async function cleanupVerificationObjects(admin, bucket) {
  for (const upload of [...openUploads].reverse()) {
    try {
      await admin.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
      }));
    } catch (error) {
      if (!isNoSuchUpload(error)) throw error;
    }
  }
  for (const key of cleanupKeys) {
    await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

function verificationKeys(runId) {
  const readerWriteDenied = {
    "api-ready": `blobs/iam-verification/${runId}-api-ready-denied`,
    "runtime-ready": `blobs/iam-verification/${runId}-runtime-ready-denied`,
    preview: `blobs/iam-verification/${runId}-preview-denied`,
  };
  return {
    ready: `blobs/iam-verification/${runId}-ready`,
    pipelineStaging: `staging/files/iam-verification/${runId}-pipeline`,
    multipart: `staging/files/iam-verification/${runId}-multipart`,
    canvas: `canvas-visuals/iam-verification/${runId}`,
    canvasWarmup: `canvas-visuals/iam-verification/${runId}-warmup`,
    canvasDenied: `canvas-visuals/iam-verification/${runId}-staging-denied`,
    blobCanvasDenied: `blobs/iam-verification/${runId}-canvas-denied`,
    pendingBlob: `pending/blobs/iam-verification/${runId}`,
    pipelineBlob: `blobs/iam-verification/${runId}-pipeline`,
    pipelineConditional: `blobs/iam-verification/${runId}-pipeline-conditional`,
    quarantine: `quarantine/blobs/iam-verification/${runId}`,
    importPending: `pending/imports/iam-verification/${runId}`,
    importBlob: `blobs/iam-verification/${runId}-import`,
    importConditional: `blobs/iam-verification/${runId}-import-conditional`,
    importWarmup: `pending/imports/iam-verification/${runId}-warmup`,
    importDenied: `pending/imports/iam-verification/${runId}-pipeline-denied`,
    exportPending: `pending/exports/iam-verification/${runId}`,
    exportBlob: `blobs/iam-verification/${runId}-export`,
    exportConditional: `blobs/iam-verification/${runId}-export-conditional`,
    exportWarmup: `pending/exports/iam-verification/${runId}-warmup`,
    exportDenied: `pending/exports/iam-verification/${runId}-import-denied`,
    importExportDenied: `pending/imports/iam-verification/${runId}-export-denied`,
    readerWriteDenied,
  };
}

function createClient({ region, endpoint, forcePathStyle, credentials }) {
  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function roleCredentials(prefix) {
  return {
    accessKeyId: required(`${prefix}_ACCESS_KEY_ID`),
    secretAccessKey: required(`${prefix}_SECRET_ACCESS_KEY`),
  };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function strictBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE must be true or false");
}

function canonicalUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return value.replace(/\/+$/u, "");
}

function canonicalOrigin(value) {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:") {
    throw new Error("WORKBENCH_OSS_WEB_ORIGIN must be an HTTPS origin");
  }
  return value;
}

function objectUrl(base, key) {
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function assertCorsOrigin(response, expectedOrigin) {
  if (response.headers.get("access-control-allow-origin") !== expectedOrigin) {
    throw verificationError("CORS_ORIGIN_MISMATCH");
  }
}

function headerTokens(response, name) {
  return (response.headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

async function consumeBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw verificationError("OBJECT_BODY_MISSING");
  }
  for await (const _chunk of body) {
    // Drain the body so the SDK can reuse its connection.
  }
}

async function bodyBytes(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw verificationError("OBJECT_BODY_MISSING");
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isAccessDenied(error) {
  const candidate = error && typeof error === "object" ? error : {};
  return candidate.name === "AccessDenied"
    || candidate.Code === "AccessDenied"
    || candidate.code === "AccessDenied"
    || candidate.$metadata?.httpStatusCode === 403;
}

function isNoSuchUpload(error) {
  const candidate = error && typeof error === "object" ? error : {};
  return candidate.name === "NoSuchUpload" || candidate.Code === "NoSuchUpload";
}

function safeFailure(error, check) {
  const candidate = error && typeof error === "object" ? error : {};
  return {
    check,
    code: String(candidate.code ?? candidate.Code ?? candidate.name ?? "UNKNOWN_ERROR"),
    ...(Number.isInteger(candidate.$metadata?.httpStatusCode)
      ? { httpStatusCode: candidate.$metadata.httpStatusCode }
      : {}),
  };
}

function verificationError(code) {
  const error = new Error(code);
  error.name = code;
  return error;
}

function writeEvidence(path, evidence) {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  for (const secretName of [
    "ALIBABACLOUD_ACCESS_KEY_ID",
    "ALIBABACLOUD_ACCESS_KEY_SECRET",
    ...Object.values(ROLE_PREFIXES).flatMap((prefix) => [
      `${prefix}_ACCESS_KEY_ID`,
      `${prefix}_SECRET_ACCESS_KEY`,
    ]),
  ]) {
    const secret = process.env[secretName];
    if (secret && serialized.includes(secret)) throw new Error("evidence contains credential material");
  }
  writeFileSync(path, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
