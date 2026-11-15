"use client";

import { useWorkbenchFilesApi } from "../api-adapter";
import type { WorkbenchFileTransferService } from "../../../files/uppy-multipart";

export {
  createWorkbenchMultipartUpload,
  type WorkbenchFileTransferService,
  type WorkbenchMultipartUpload,
} from "../../../files/uppy-multipart";
export {
  useWorkbenchUploadRegistry,
  type WorkbenchUploadBatchResult,
  type WorkbenchUploadInput,
} from "../../../files/upload-registry";

export function useWorkbenchFileTransferService(): WorkbenchFileTransferService {
  return useWorkbenchFilesApi();
}
