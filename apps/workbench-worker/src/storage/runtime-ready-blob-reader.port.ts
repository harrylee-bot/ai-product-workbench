import type { VerifiedReadyObjectBody } from "@workbench/workbench-content-security";
import type { RuntimeContentLocator } from "../runtime/runtime.port.js";

export type RuntimeReadyBlobBody = {
  body: VerifiedReadyObjectBody;
  byteSize: number;
  mediaType: string | null;
};

export interface RuntimeReadyBlobReader {
  getObject(locator: RuntimeContentLocator, signal?: AbortSignal): Promise<RuntimeReadyBlobBody>;
}
