import { describe, expect, it } from "vitest";

import {
  runEventSourceIdMaxLength,
  runEventSourceIdSchema,
} from "../src/common.js";

describe("RunEvent source identity contract", () => {
  it("accepts the canonical transport-safe alphabet", () => {
    expect(runEventSourceIdSchema.parse("deerflow:attempt_1.screen-1"))
      .toBe("deerflow:attempt_1.screen-1");
    expect(runEventSourceIdSchema.parse("a".repeat(runEventSourceIdMaxLength)))
      .toHaveLength(runEventSourceIdMaxLength);
  });

  it.each([
    "",
    "contains space",
    "runtime/tool#1",
    "中文-source",
    "a".repeat(runEventSourceIdMaxLength + 1),
  ])("rejects non-canonical source id %j", (sourceId) => {
    expect(runEventSourceIdSchema.safeParse(sourceId).success).toBe(false);
  });
});
