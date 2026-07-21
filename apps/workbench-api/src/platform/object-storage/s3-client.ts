import { S3Client } from "@aws-sdk/client-s3";
import type { ObjectStorageConfig, S3RoleCredentials } from "./object-storage.config.js";

export function createS3Client(
  config: Pick<ObjectStorageConfig, "region" | "internalEndpoint" | "forcePathStyle">,
  credentials: S3RoleCredentials,
) {
  return new S3Client({
    region: config.region,
    ...(config.internalEndpoint ? { endpoint: config.internalEndpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials,
  });
}

export function createS3BrowserUploadClient(
  config: Pick<ObjectStorageConfig, "region">,
  credentials: S3RoleCredentials,
) {
  return new S3Client({
    region: config.region,
    bucketEndpoint: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials,
  });
}
