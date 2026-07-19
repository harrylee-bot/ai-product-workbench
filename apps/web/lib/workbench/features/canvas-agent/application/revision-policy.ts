export type CanvasAgentRevisionDisposition = "current" | "future" | "stale";

export function canvasAgentRevisionDisposition(
  commandRevision: number,
  currentRevision: number,
): CanvasAgentRevisionDisposition {
  if (commandRevision < currentRevision) return "stale";
  if (commandRevision > currentRevision) return "future";
  return "current";
}
