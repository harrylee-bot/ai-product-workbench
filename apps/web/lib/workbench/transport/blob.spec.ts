// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { Blob as NodeBlob } from "node:buffer";

import { isWorkbenchBlob } from "./blob";

describe("Workbench Blob contract", () => {
  it("accepts native and cross-realm Fetch Blob values", async () => {
    const native = new Blob(["native"], { type: "text/plain" });
    const crossRealm = new NodeBlob([new Uint8Array([1, 2, 3])]);

    expect(isWorkbenchBlob(native)).toBe(true);
    expect(crossRealm).not.toBeInstanceOf(Blob);
    expect(isWorkbenchBlob(crossRealm)).toBe(true);
    expect(Object.prototype.toString.call(crossRealm)).toBe("[object Blob]");
    expect(new Uint8Array(await crossRealm.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects ordinary objects that spoof the Blob tag and surface", () => {
    const spoofed = {
      arrayBuffer: async () => new ArrayBuffer(0),
      size: 0,
      slice: () => spoofed,
      stream: () => new ReadableStream(),
      text: async () => "",
      type: "application/octet-stream",
      [Symbol.toStringTag]: "Blob",
    };

    expect(isWorkbenchBlob(spoofed)).toBe(false);
    expect(isWorkbenchBlob({})).toBe(false);
    expect(isWorkbenchBlob(null)).toBe(false);
  });
});
