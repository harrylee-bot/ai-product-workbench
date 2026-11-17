// Derived from react-swarm-rebuild (MIT), Copyright (c) 2026 Nguyễn Quốc Cường.
// Upstream: 0d3e04eba408ea7ad4fd47aecbd0b1a7c634a233; see third_party/react-swarm-rebuild/README.md.
export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
export const ease = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;
export function finite(
  n: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  return Number.isFinite(n) ? clamp(n!, min, max) : fallback;
}
export function stepSpring(
  position: number,
  velocity: number,
  target: number,
  dt: number,
) {
  const nextVelocity =
    (velocity + (target - position) * 20 * dt) * Math.exp(-7 * dt);
  return { position: position + nextVelocity * dt, velocity: nextVelocity };
}
