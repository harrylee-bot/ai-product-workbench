import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFrozenPrototypeHtml } from "../src/index.js";

const page = { id: "page_1", slug: "home", title: "首页", route: "/", order: 0, content: '<button data-prototype-feedback="open">提交</button>', sha256: createHash("sha256").update('<button data-prototype-feedback="open">提交</button>').digest("hex") };

describe("visual prototype build worker", () => {
  it("freezes a deterministic multi-page HTML shell without a browser in unit mode", async () => {
    const artifact = await buildFrozenPrototypeHtml("revision_1", "Demo", [page], { requireBrowserCheck: false });
    expect(artifact.document.pages).toHaveLength(1);
    expect(artifact.htmlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.byteSize).toBeGreaterThan(0);
    expect(artifact.html).toContain("data-prototype-revision");
  });
});
