import { describe, expect, it } from "vitest";

import { normalizeWorkbenchProductLink } from "./product-links";

describe("normalizeWorkbenchProductLink", () => {
  it("accepts an approved HTTPS destination", () => {
    expect(normalizeWorkbenchProductLink(
      " https://support.example.com/workbench ",
      ["https:"],
    )).toBe("https://support.example.com/workbench");
  });

  it("accepts mailto only when explicitly allowed", () => {
    expect(normalizeWorkbenchProductLink(
      "mailto:feedback@example.com?subject=Workbench",
      ["https:", "mailto:"],
    )).toBe("mailto:feedback@example.com?subject=Workbench");
    expect(normalizeWorkbenchProductLink(
      "mailto:feedback@example.com",
      ["https:"],
    )).toBeNull();
  });

  it("rejects credentials, unsafe protocols, relative paths, and empty values", () => {
    expect(normalizeWorkbenchProductLink(
      "https://user:secret@example.com/private",
      ["https:"],
    )).toBeNull();
    expect(normalizeWorkbenchProductLink("javascript:alert(1)", ["https:"])).toBeNull();
    expect(normalizeWorkbenchProductLink("/privacy", ["https:"])).toBeNull();
    expect(normalizeWorkbenchProductLink("  ", ["https:"])).toBeNull();
  });
});
