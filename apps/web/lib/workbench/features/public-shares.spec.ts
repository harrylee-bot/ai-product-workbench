import { describe, expect, it } from "vitest";

import { workbenchQueryKeys } from "../query/keys";
import { publicShareTokenScope } from "./public-shares";

describe("public Share query scope", () => {
  it("is stable without storing raw bearer material in TanStack Query keys", () => {
    const token = `wbs_${"A".repeat(43)}`;
    const scope = publicShareTokenScope(token);
    expect(scope).toMatch(/^[a-f0-9]{16}$/);
    expect(scope).toBe(publicShareTokenScope(token));
    expect(scope).not.toContain(token);
    expect(publicShareTokenScope(`${token}B`)).not.toBe(scope);
    const contentKey = workbenchQueryKeys.publicSharedArtifactContent(
      scope,
      "artifact-1",
      "version-1",
    );
    expect(contentKey.at(-1)).toBe("content");
    expect(JSON.stringify(contentKey)).not.toContain(token);
  });

  it("includes token order and the complete suffix in the opaque scope", () => {
    expect(publicShareTokenScope("share-ab")).not.toBe(publicShareTokenScope("share-ba"));
    expect(publicShareTokenScope("share-alpha")).not.toBe(
      publicShareTokenScope("share-beta"),
    );
  });
});
