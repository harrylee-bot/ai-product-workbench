import { describe, expect, it } from "vitest";

import { canvasAgentRevisionDisposition } from "./revision-policy";

describe("Canvas Agent revision policy", () => {
  it.each([
    [4, 5, "stale"],
    [5, 5, "current"],
    [6, 5, "future"],
  ] as const)("classifies command revision %s against current %s", (
    commandRevision,
    currentRevision,
    expected,
  ) => {
    expect(canvasAgentRevisionDisposition(commandRevision, currentRevision)).toBe(expected);
  });
});
