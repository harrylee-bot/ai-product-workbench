import { describe, expect, it } from "vitest";

import { workbenchRunIsActive, workbenchRunIsVisuallyGenerating } from "./status";

describe("workbench run status predicates", () => {
  it.each(["queued", "running"] as const)(
    "treats %s as visually generating",
    (status) => {
      expect(workbenchRunIsVisuallyGenerating(status)).toBe(true);
    },
  );

  it.each(["waiting_input", "cancelling", "succeeded", "failed", "cancelled"] as const)(
    "keeps %s active semantics separate from visual generation",
    (status) => {
      expect(workbenchRunIsVisuallyGenerating(status)).toBe(false);
      expect(workbenchRunIsActive(status)).toBe(status === "waiting_input" || status === "cancelling");
    },
  );

  it("treats an absent run as neither active nor visually generating", () => {
    expect(workbenchRunIsActive(null)).toBe(false);
    expect(workbenchRunIsVisuallyGenerating(null)).toBe(false);
  });
});
