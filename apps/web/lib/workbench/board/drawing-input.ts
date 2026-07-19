import { maximumBoardDrawingPointCount } from "@workbench/workbench-contracts";

import type { BoardDrawingSample } from "./tool-actions";

export const maximumBoardDrawingGesturePoints = maximumBoardDrawingPointCount;

const minimumDrawingSampleDistanceSquared = 0.25;
const minimumDrawingPressureDelta = 0.02;

export type BoardDrawingGestureBuffer = {
  localPoints: Array<[number, number, number]>;
  flowPoints: BoardDrawingSample[];
};

export function appendBoardDrawingGestureSample(
  buffer: BoardDrawingGestureBuffer,
  sample: {
    local: { x: number; y: number };
    flow: { x: number; y: number };
    pressure: number;
  },
  force = false,
): boolean {
  const previous = buffer.localPoints.at(-1);
  if (
    !force
    && previous
    && ((sample.local.x - previous[0]) ** 2) + ((sample.local.y - previous[1]) ** 2)
      < minimumDrawingSampleDistanceSquared
    && Math.abs(sample.pressure - previous[2]) < minimumDrawingPressureDelta
  ) {
    return false;
  }

  const localSample: [number, number, number] = [
    sample.local.x,
    sample.local.y,
    sample.pressure,
  ];
  const flowSample = { ...sample.flow, pressure: sample.pressure };
  if (buffer.flowPoints.length < maximumBoardDrawingGesturePoints) {
    buffer.localPoints.push(localSample);
    buffer.flowPoints.push(flowSample);
  } else {
    buffer.localPoints[buffer.localPoints.length - 1] = localSample;
    buffer.flowPoints[buffer.flowPoints.length - 1] = flowSample;
  }
  return true;
}

export function boardDrawingUsesSimulatedPressure(pointerType: string): boolean {
  return pointerType !== "pen";
}

export function normalizeBoardDrawingPressure(value: number, simulatePressure: boolean): number {
  if (simulatePressure) return 0.5;
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function boardDrawingDraftStrokeSize(zoom: number, size = 5): number {
  if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError("Board zoom must be positive");
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Board drawing size must be positive");
  return zoom * size;
}
