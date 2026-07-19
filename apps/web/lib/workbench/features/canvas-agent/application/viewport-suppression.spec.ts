import { describe, expect, it } from "vitest";

import {
  CanvasAgentViewportMoveSuppression,
  viewportsMatch,
} from "./viewport-suppression";

describe("CanvasAgentViewportMoveSuppression", () => {
  it("suppresses a matching programmatic move exactly once", () => {
    const suppression = new CanvasAgentViewportMoveSuppression();
    suppression.arm({ x: 100, y: 200, zoom: 1.5 });

    expect(suppression.consumeIfMatches({ x: 100.25, y: 199.75, zoom: 1.50001 }))
      .toBe(true);
    expect(suppression.pendingToken).toBeNull();
    expect(suppression.consumeIfMatches({ x: 100, y: 200, zoom: 1.5 })).toBe(false);
  });

  it("does not consume a token for an unrelated viewport", () => {
    const suppression = new CanvasAgentViewportMoveSuppression();
    const token = suppression.arm({ x: 100, y: 200, zoom: 1.5 });

    expect(suppression.consumeIfMatches({ x: 0, y: 0, zoom: 1 })).toBe(false);
    expect(suppression.pendingToken).toBe(token);
  });

  it("can cancel a pending token when the user starts moving", () => {
    const suppression = new CanvasAgentViewportMoveSuppression();
    const oldToken = suppression.arm({ x: 100, y: 200, zoom: 1.5 });
    const currentToken = suppression.arm({ x: 0, y: 0, zoom: 1 });

    suppression.cancel(oldToken);
    expect(suppression.pendingToken).toBe(currentToken);
    suppression.cancel(currentToken);
    expect(suppression.pendingToken).toBeNull();
  });

  it("supports exact matching for callers that require it", () => {
    expect(viewportsMatch(
      { x: 1, y: 2, zoom: 1 },
      { x: 1.1, y: 2, zoom: 1 },
      { position: 0, zoom: 0 },
    )).toBe(false);
  });
});
