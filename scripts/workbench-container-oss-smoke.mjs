#!/usr/bin/env node

import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

const operation = required("WORKBENCH_OSS_SMOKE_OPERATION");
const key = required("WORKBENCH_OSS_SMOKE_KEY");
const credentialPrefix = required("WORKBENCH_OSS_SMOKE_CREDENTIAL_PREFIX");
if (!/^WORKBENCH_[A-Z0-9_]+_S3$/u.test(credentialPrefix)) {
  throw new Error("WORKBENCH_OSS_SMOKE_CREDENTIAL_PREFIX is invalid");
}
const body = Buffer.from(process.env.WORKBENCH_OSS_SMOKE_BODY ?? "workbench-oss-container-smoke");
const client = new S3Client({
  region: required("WORKBENCH_S3_REGION"),
  endpoint: required("WORKBENCH_S3_INTERNAL_ENDPOINT"),
  forcePathStyle: strictBoolean(required("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE")),
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: required(`${credentialPrefix}_ACCESS_KEY_ID`),
    secretAccessKey: required(`${credentialPrefix}_SECRET_ACCESS_KEY`),
  },
});
const bucket = required("WORKBENCH_S3_BUCKET");

try {
  if (operation === "get") {
    await getAndVerify();
  } else if (operation === "head") {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    process.stdout.write(`${JSON.stringify({
      byteSize: result.ContentLength,
      mediaType: result.ContentType,
      metadata: result.Metadata,
    })}\n`);
  } else if (operation === "delete") {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } else if (operation === "put-get") {
    await put();
    await getAndVerify();
  } else if (operation === "put-get-delete") {
    await put();
    await getAndVerify();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } else if (operation === "conditional-stream-put-get-delete") {
    await put({ conditional: true, stream: true });
    await getAndVerify();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } else if (operation === "conditional-stream-copy-get-delete") {
    await streamCopy();
  } else if (operation === "adapter-promote-get-delete") {
    await adapterPromote();
  } else if (operation === "multipart-abort") {
    const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
    if (!created.UploadId) throw new Error("multipart upload id is missing");
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: created.UploadId,
    }));
  } else {
    throw new Error(`unsupported smoke operation: ${operation}`);
  }
  process.stdout.write(`${operation} passed\n`);
} finally {
  client.destroy();
}

async function put(options = {}) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: options.stream ? Readable.from([body]) : body,
    ContentLength: body.byteLength,
  });
  if (options.conditional) {
    command.middlewareStack.add(
      (next) => async (arguments_) => {
        if (!arguments_.request || typeof arguments_.request !== "object") {
          throw new Error("OSS_HTTP_REQUEST_UNAVAILABLE");
        }
        const headers = arguments_.request.headers;
        if (!headers || typeof headers !== "object") throw new Error("OSS_HTTP_HEADERS_UNAVAILABLE");
        headers["x-oss-forbid-overwrite"] = "true";
        return next(arguments_);
      },
      { step: "build", name: "workbenchOssForbidOverwrite", priority: "low" },
    );
  }
  await client.send(command);
}

async function streamCopy() {
  const sourceKey = required("WORKBENCH_OSS_SMOKE_SOURCE_KEY");
  const existingSource = process.env.WORKBENCH_OSS_SMOKE_SOURCE_EXISTING === "true";
  if (!existingSource) {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: sourceKey,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: "text/plain",
    }));
  }
  try {
    const source = await client.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
    if (!source.Body || typeof source.Body.pipe !== "function") throw new Error("source body is unavailable");
    if (!Number.isSafeInteger(source.ContentLength)) throw new Error("source size is unavailable");
    const hashingBody = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } });
    source.Body.pipe(hashingBody);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: hashingBody,
      ContentLength: source.ContentLength,
      ContentType: "text/plain",
      Metadata: { sha256: "0".repeat(64), "byte-size": String(source.ContentLength) },
    });
    command.middlewareStack.add(
      (next) => async (arguments_) => {
        if (!arguments_.request || typeof arguments_.request !== "object") {
          throw new Error("OSS_HTTP_REQUEST_UNAVAILABLE");
        }
        const headers = arguments_.request.headers;
        if (!headers || typeof headers !== "object") throw new Error("OSS_HTTP_HEADERS_UNAVAILABLE");
        headers["x-oss-forbid-overwrite"] = "true";
        return next(arguments_);
      },
      { step: "build", name: "workbenchOssForbidOverwrite", priority: "low" },
    );
    await client.send(command);
    if (existingSource) {
      const copied = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (copied.ContentLength !== source.ContentLength) throw new Error("copied object size mismatch");
    } else {
      await getAndVerify();
    }
  } finally {
    const cleanup = [client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))];
    if (!existingSource) cleanup.push(client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey })));
    await Promise.allSettled(cleanup);
  }
}

async function adapterPromote() {
  const sourceKey = required("WORKBENCH_OSS_SMOKE_SOURCE_KEY");
  const { S3FileStorageAdapter } = await import(
    "./apps/workbench-file-worker/dist/storage/s3-file-storage.adapter.js"
  );
  const adapter = new S3FileStorageAdapter({
    s3Bucket: bucket,
    s3Region: required("WORKBENCH_S3_REGION"),
    s3InternalEndpoint: required("WORKBENCH_S3_INTERNAL_ENDPOINT"),
    s3ForcePathStyle: strictBoolean(required("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE")),
    s3ConditionalCreateMode: required("WORKBENCH_S3_CONDITIONAL_CREATE_MODE"),
    filePipelineS3AccessKeyId: required("WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID"),
    filePipelineS3SecretAccessKey: required("WORKBENCH_FILE_PIPELINE_S3_SECRET_ACCESS_KEY"),
  }, async () => {});
  try {
    await adapter.promoteObject({
      sourceKey,
      destinationKey: key,
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      mediaType: "text/plain",
    });
    await getAndVerify();
  } finally {
    await adapter.deleteObject(key).catch(() => undefined);
  }
}

async function getAndVerify() {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body || typeof result.Body[Symbol.asyncIterator] !== "function") {
    throw new Error("object body is unavailable");
  }
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
  if (!Buffer.concat(chunks).equals(body)) throw new Error("object body mismatch");
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
