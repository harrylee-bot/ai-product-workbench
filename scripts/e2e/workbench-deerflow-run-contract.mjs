// Matches the pinned 2.1.0 gateway run_models.py and runtime/stream_modes.py.
// The public request spelling is messages-tuple; the emitted SSE event remains messages.
const streamModes = new Set([
  "values", "messages-tuple", "updates", "debug", "tasks", "checkpoints", "custom",
]);

export function deerFlowNativeRunRequestViolation(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid_run_request";
  if (body.stream_resumable !== undefined && body.stream_resumable !== null && body.stream_resumable !== false) {
    return "unsupported_run_option";
  }
  const requested = body.stream_mode ?? "values";
  const modes = Array.isArray(requested) ? requested : [requested];
  if (modes.some((mode) => typeof mode !== "string" || !streamModes.has(mode))) {
    return "unsupported_stream_mode";
  }
  return null;
}
