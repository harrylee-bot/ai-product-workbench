import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("prototype preview iframe sandbox", () => {
  it("allows scripts but never same-origin for generated prototype HTML", () => {
    const source = readFileSync(
      path.resolve(__dirname, "prototype-preview-view.tsx"),
      "utf8",
    );

    const sandboxAttributes = [...source.matchAll(/sandbox=\"([^\"]*)\"/g)].map((match) => match[1]);

    expect(sandboxAttributes).toContain("allow-scripts");
    expect(sandboxAttributes).not.toContain(expect.stringContaining("allow-same-origin"));
  });
});
