import { describe, expect, it } from "vitest";
import {
  workbenchPreviewHandshakeSchema,
  workbenchPreviewRpcChannelForCapability,
  workbenchPreviewStatusSchema,
} from "../src/preview-rpc.js";

describe("Preview RPC contract", () => {
  it("accepts only the exact v1 handshake", () => {
    expect(workbenchPreviewHandshakeSchema.parse({
      protocol: "workbench.preview",
      version: 1,
    })).toEqual({ protocol: "workbench.preview", version: 1 });
    expect(workbenchPreviewHandshakeSchema.safeParse({
      protocol: "workbench.preview",
      version: 2,
    }).success).toBe(false);
    expect(workbenchPreviewRpcChannelForCapability("wbpv1.payload.signature"))
      .toBe("workbench.preview.v1:wbpv1.payload.signature");
    expect(() => workbenchPreviewRpcChannelForCapability("path/token"))
      .toThrow();
    expect(workbenchPreviewHandshakeSchema.safeParse({
      protocol: "workbench.preview",
      version: 1,
      command: "arbitrary",
    }).success).toBe(false);
  });

  it("accepts only explicit ready and bounded error states", () => {
    expect(workbenchPreviewStatusSchema.parse({
      protocol: "workbench.preview",
      version: 1,
      state: "ready",
      errorCode: null,
    }).state).toBe("ready");
    expect(workbenchPreviewStatusSchema.safeParse({
      protocol: "workbench.preview",
      version: 1,
      state: "error",
      errorCode: "ARBITRARY_ERROR",
    }).success).toBe(false);
    expect(workbenchPreviewStatusSchema.safeParse({
      protocol: "workbench.preview",
      version: 1,
      state: "ready",
      errorCode: null,
      data: {},
    }).success).toBe(false);
  });
});
