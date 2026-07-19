import { FailClosedScanAdapter, RetryableScanError } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("content security scan boundary", () => {
  it("fails closed when no scanner is configured", async () => {
    await expect(new FailClosedScanAdapter().scan({
      body: (async function* () {
        yield Uint8Array.of(0);
      })(),
      byteSize: 1,
      sha256: "a".repeat(64),
      mediaType: "text/plain",
    })).rejects.toBeInstanceOf(RetryableScanError);
  });
});
