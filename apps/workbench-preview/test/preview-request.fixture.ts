import { preparePreviewResponse } from "../src/preview-request.js";
import type { PreviewService } from "../src/preview.service.js";

export async function getPreview(service: PreviewService, token: string) {
  const response = await preparePreviewResponse(service, { token, method: "GET" });
  if (response.status !== 200 || response.head) throw new Error("Expected a rendered GET response");
  return response.preview;
}
