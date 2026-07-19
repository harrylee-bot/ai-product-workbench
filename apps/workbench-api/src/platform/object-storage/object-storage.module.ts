import { Module } from "@nestjs/common";
import { ObjectStorageConfig } from "./object-storage.config.js";
import {
  CANVAS_VISUAL_STORAGE_PORT,
  MULTIPART_STORAGE_PORT,
  READY_BLOB_STORAGE_PORT,
} from "./object-storage.port.js";
import { S3CanvasVisualStorageAdapter } from "./s3-canvas-visual-storage.adapter.js";
import { S3MultipartStorageAdapter } from "./s3-multipart-storage.adapter.js";
import { S3ReadyBlobStorageAdapter } from "./s3-ready-blob-storage.adapter.js";

@Module({
  providers: [
    ObjectStorageConfig,
    S3MultipartStorageAdapter,
    S3ReadyBlobStorageAdapter,
    S3CanvasVisualStorageAdapter,
    { provide: MULTIPART_STORAGE_PORT, useExisting: S3MultipartStorageAdapter },
    { provide: READY_BLOB_STORAGE_PORT, useExisting: S3ReadyBlobStorageAdapter },
    { provide: CANVAS_VISUAL_STORAGE_PORT, useExisting: S3CanvasVisualStorageAdapter },
  ],
  exports: [MULTIPART_STORAGE_PORT, READY_BLOB_STORAGE_PORT, CANVAS_VISUAL_STORAGE_PORT],
})
export class ObjectStorageModule {}
