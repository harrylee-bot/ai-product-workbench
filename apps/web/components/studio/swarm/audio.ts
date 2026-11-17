// Derived from react-swarm-rebuild (MIT), Copyright (c) 2026 Nguyễn Quốc Cường.
// Upstream: 0d3e04eba408ea7ad4fd47aecbd0b1a7c634a233; see third_party/react-swarm-rebuild/README.md.
/** Small, original Web Audio instrument. No audio files or network requests. */
export class SwarmAudio {
  private context?: AudioContext;
  private enabled = false;
  private last = 0;
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      try {
        this.context ??= new AudioContext();
        void this.context.resume().catch(() => {});
      } catch {
        /* Audio is optional in restricted browsers. */
      }
    }
  }
  play(kind: "type" | "draw" | "complete", x = 0.5) {
    const ctx = this.context;
    if (
      !this.enabled ||
      !ctx ||
      ctx.state !== "running" ||
      ctx.currentTime - this.last < 0.035
    )
      return;
    this.last = ctx.currentTime;
    const oscillator = ctx.createOscillator(),
      gain = ctx.createGain(),
      pan = ctx.createStereoPanner();
    const time = ctx.currentTime;
    oscillator.type = kind === "type" ? "triangle" : "sine";
    const notes = [164.81, 185, 207.65, 246.94, 277.18, 329.63, 369.99];
    const frequency =
      kind === "type"
        ? 650 + Math.random() * 800
        : notes[Math.floor(Math.max(0, Math.min(0.999, x)) * notes.length)];
    oscillator.frequency.setValueAtTime(frequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(
      kind === "type" ? 180 : frequency,
      time + 0.04,
    );
    const duration = kind === "complete" ? 0.8 : kind === "type" ? 0.035 : 0.18;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(
      kind === "type" ? 0.018 : 0.035,
      time + 0.004,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    pan.pan.value = Math.max(-1, Math.min(1, x * 2 - 1));
    oscillator.connect(gain).connect(pan).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(time + duration + 0.01);
  }
  destroy() {
    if (this.context) void this.context.close().catch(() => {});
    this.context = undefined;
  }
}
