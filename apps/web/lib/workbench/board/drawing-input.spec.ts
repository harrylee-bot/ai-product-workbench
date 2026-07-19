import { describe, expect, it } from "vitest";

import {
  appendBoardDrawingGestureSample,
  boardDrawingDraftStrokeSize,
  boardDrawingUsesSimulatedPressure,
  maximumBoardDrawingGesturePoints,
  normalizeBoardDrawingPressure,
} from "./drawing-input";

describe("Board drawing pointer input", () => {
  it("simulates mouse/touch pressure but preserves clamped pen pressure", () => {
    expect(boardDrawingUsesSimulatedPressure("mouse")).toBe(true);
    expect(boardDrawingUsesSimulatedPressure("touch")).toBe(true);
    expect(boardDrawingUsesSimulatedPressure("pen")).toBe(false);
    expect(normalizeBoardDrawingPressure(0.12, true)).toBe(0.5);
    expect(normalizeBoardDrawingPressure(0.72, false)).toBe(0.72);
    expect(normalizeBoardDrawingPressure(2, false)).toBe(1);
  });

  it("drops near-identical samples while preserving meaningful pressure changes", () => {
    const buffer = {
      localPoints: [[10, 10, 0.5] as [number, number, number]],
      flowPoints: [{ x: 20, y: 20, pressure: 0.5 }],
    };
    expect(appendBoardDrawingGestureSample(buffer, {
      local: { x: 10.1, y: 10.1 },
      flow: { x: 20.1, y: 20.1 },
      pressure: 0.5,
    })).toBe(false);
    expect(appendBoardDrawingGestureSample(buffer, {
      local: { x: 10.1, y: 10.1 },
      flow: { x: 20.1, y: 20.1 },
      pressure: 0.7,
    })).toBe(true);
    expect(buffer.flowPoints).toHaveLength(2);
  });

  it("keeps a bounded buffer and replaces its live endpoint at capacity", () => {
    const buffer = {
      localPoints: Array.from(
        { length: maximumBoardDrawingGesturePoints },
        (_, index) => [index, index, 0.5] as [number, number, number],
      ),
      flowPoints: Array.from(
        { length: maximumBoardDrawingGesturePoints },
        (_, index) => ({ x: index, y: index, pressure: 0.5 }),
      ),
    };
    expect(appendBoardDrawingGestureSample(buffer, {
      local: { x: 10_000, y: 20_000 },
      flow: { x: 30_000, y: 40_000 },
      pressure: 0.8,
    }, true)).toBe(true);
    expect(buffer.flowPoints).toHaveLength(maximumBoardDrawingGesturePoints);
    expect(buffer.localPoints.at(-1)).toEqual([10_000, 20_000, 0.8]);
    expect(buffer.flowPoints.at(-1)).toEqual({ x: 30_000, y: 40_000, pressure: 0.8 });
  });

  it("maps a world-space stroke width to the current screen zoom", () => {
    expect(boardDrawingDraftStrokeSize(1, 5)).toBe(5);
    expect(boardDrawingDraftStrokeSize(0.5, 5)).toBe(2.5);
    expect(() => boardDrawingDraftStrokeSize(0)).toThrow(/zoom/);
  });
});
