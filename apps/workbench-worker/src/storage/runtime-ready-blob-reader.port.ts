import type { Readable } from "node:stream";
import type { RuntimeContentLocator } from "../runtime/runtime.port.js";

export type RuntimeReadyBlobBody = {
  body: Readable;
  byteSize: number;
  mediaType: string | null;
};

export interface RuntimeReadyBlobReader {
  getObject(locator: RuntimeContentLocator, signal?: AbortSignal): Promise<RuntimeReadyBlobBody>;
}
