import { describe, expect, it } from "vitest";
import { verifyDownload } from "./actions";
describe("browser export integrity", () => {
  const expected = {
    size: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  };
  it("allows exactly the frozen bytes and rejects truncation and equal-length tampering", async () => {
    const blob = new Blob(["abc"]);
    expect(await verifyDownload(blob, expected)).toBe(blob);
    await expect(verifyDownload(new Blob(["ab"]), expected)).rejects.toThrow(
      "大小",
    );
    await expect(verifyDownload(new Blob(["abd"]), expected)).rejects.toThrow(
      "内容",
    );
  });
});
