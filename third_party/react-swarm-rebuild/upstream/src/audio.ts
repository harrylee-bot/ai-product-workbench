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
      } catch { /* Audio is optional in restricted browsers. */ }
    }
  }
  play(kind: 'type' | 'draw' | 'complete', x = .5) {
    const ctx = this.context;
    if (!this.enabled || !ctx || ctx.state !== 'running' || ctx.currentTime - this.last < .035) return;
    this.last = ctx.currentTime;
    const oscillator = ctx.createOscillator(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
    const time = ctx.currentTime;
    oscillator.type = kind === 'type' ? 'triangle' : 'sine';
    const notes = [164.81, 185, 207.65, 246.94, 277.18, 329.63, 369.99];
    const frequency = kind === 'type' ? 650 + Math.random() * 800 : notes[Math.floor(Math.max(0, Math.min(.999, x)) * notes.length)];
    oscillator.frequency.setValueAtTime(frequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'type' ? 180 : frequency, time + .04);
    const duration = kind === 'complete' ? .8 : kind === 'type' ? .035 : .18;
    gain.gain.setValueAtTime(.0001, time);
    gain.gain.exponentialRampToValueAtTime(kind === 'type' ? .018 : .035, time + .004);
    gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    pan.pan.value = Math.max(-1, Math.min(1, x * 2 - 1));
    oscillator.connect(gain).connect(pan).connect(ctx.destination);
    oscillator.start(); oscillator.stop(time + duration + .01);
  }
  destroy() { if (this.context) void this.context.close().catch(() => {}); this.context = undefined; }
}
