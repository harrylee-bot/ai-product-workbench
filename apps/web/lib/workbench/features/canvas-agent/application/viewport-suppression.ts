import type { Viewport } from "@xyflow/system";

export type CanvasAgentViewportSuppressionToken = number;

export type CanvasAgentViewportTolerance = {
  position: number;
  zoom: number;
};

const DEFAULT_TOLERANCE: CanvasAgentViewportTolerance = {
  position: 0.5,
  zoom: 0.0001,
};

export class CanvasAgentViewportMoveSuppression {
  #nextToken = 1;
  #pending: {
    target: Viewport;
    token: CanvasAgentViewportSuppressionToken;
  } | null = null;
  readonly #tolerance: CanvasAgentViewportTolerance;

  constructor(tolerance: Partial<CanvasAgentViewportTolerance> = {}) {
    this.#tolerance = {
      position: normalizeTolerance(tolerance.position, DEFAULT_TOLERANCE.position),
      zoom: normalizeTolerance(tolerance.zoom, DEFAULT_TOLERANCE.zoom),
    };
  }

  arm(target: Viewport): CanvasAgentViewportSuppressionToken {
    const token = this.#nextToken++;
    this.#pending = { target: { ...target }, token };
    return token;
  }

  consumeIfMatches(viewport: Viewport): boolean {
    if (!this.#pending || !viewportsMatch(this.#pending.target, viewport, this.#tolerance)) {
      return false;
    }
    this.#pending = null;
    return true;
  }

  cancel(token?: CanvasAgentViewportSuppressionToken): void {
    if (token !== undefined && this.#pending?.token !== token) return;
    this.#pending = null;
  }

  get pendingToken(): CanvasAgentViewportSuppressionToken | null {
    return this.#pending?.token ?? null;
  }
}

export function viewportsMatch(
  expected: Viewport,
  actual: Viewport,
  tolerance: CanvasAgentViewportTolerance = DEFAULT_TOLERANCE,
): boolean {
  return Math.abs(expected.x - actual.x) <= tolerance.position
    && Math.abs(expected.y - actual.y) <= tolerance.position
    && Math.abs(expected.zoom - actual.zoom) <= tolerance.zoom;
}

function normalizeTolerance(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}
