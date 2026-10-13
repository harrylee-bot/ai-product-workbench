// CSS animation time advances on rendering frames, not necessarily when a timer
// fires. Observe the original element on real frames without seeking/restarting it.
export async function captureGenerationMotion(locator, {
  kind, reducedMotion, timeoutMs = 2_500, observationMs = 180,
} = {}) {
  if (!["prd", "prototype"].includes(kind) || typeof reducedMotion !== "boolean"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000
    || !Number.isSafeInteger(observationMs) || observationMs < 1 || observationMs >= timeoutMs) {
    throw new Error("GENERATION_MOTION_OPTIONS_INVALID");
  }
  let deadline;
  try {
    return await Promise.race([
      locator.evaluate((element, options) => new Promise((resolve, reject) => {
        let animationFrame, first, last, firstTimeline, lastTimeline, stage;
        let count = 0, epochSamples = 0, stageResets = 0;
        const startedAt = performance.now();
        const key = options.kind === "prd" ? "beforeBackgroundPosition" : "beforeTransform";
        const visualKeys = ["beforeBackgroundPosition", "beforeTransform", "beforeOpacity", "transform", "opacity"];
        const finish = (error) => {
          clearTimeout(timer);
          cancelAnimationFrame(animationFrame);
          if (error) reject(new Error(error));
          else resolve({ ...last, frames: [first, last], sampling: {
            method: "requestAnimationFrame", sampleCount: count,
            elapsedMs: performance.now() - startedAt,
            firstTimelineMs: firstTimeline, lastTimelineMs: lastTimeline,
            generationStage: stage, stageResets, epochSampleCount: epochSamples,
          } });
        };
        const timer = setTimeout(() => finish("GENERATION_MOTION_DEADLINE_EXCEEDED"), options.timeoutMs);
        const sample = () => {
          if (performance.now() - startedAt >= options.timeoutMs) {
            finish("GENERATION_MOTION_DEADLINE_EXCEEDED"); return;
          }
          if (!element.isConnected) { finish("GENERATION_MOTION_ELEMENT_DETACHED"); return; }
          if (element.getAttribute("data-canvas-generation-motion") !== options.kind) {
            finish("GENERATION_MOTION_KIND_CHANGED"); return;
          }
          const currentStage = element.getAttribute("data-generation-stage");
          const style = getComputedStyle(element);
          const before = getComputedStyle(element, "::before");
          const timeline = document.timeline.currentTime;
          if (typeof timeline !== "number" || !Number.isFinite(timeline)) {
            finish("GENERATION_MOTION_TIMELINE_UNAVAILABLE"); return;
          }
          last = {
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            opacity: style.opacity,
            transform: style.transform,
            beforeAnimationName: before.animationName,
            beforeAnimationDuration: before.animationDuration,
            beforeAnimationIterationCount: before.animationIterationCount,
            beforeBackgroundPosition: before.backgroundPosition,
            beforeOpacity: before.opacity,
            beforeTransform: before.transform,
          };
          count += 1;
          lastTimeline = timeline;
          if (!first || currentStage !== stage) {
            if (first) stageResets += 1;
            // Stages can naturally change during generation. Observe a complete
            // window within the new stage under the original hard deadline.
            first = last; firstTimeline = timeline; stage = currentStage; epochSamples = 0;
          }
          epochSamples += 1;
          // Check every reduced-motion sample, not just endpoints which could
          // coincide after a complete unintended animation cycle.
          if (options.reducedMotion && visualKeys.some((visualKey) => last[visualKey] !== first[visualKey])) {
            finish("GENERATION_REDUCED_MOTION_MOVED"); return;
          }
          const observedWindow = lastTimeline - firstTimeline >= options.observationMs;
          if (epochSamples >= 2 && observedWindow && (options.reducedMotion || last[key] !== first[key])) {
            finish(); return;
          }
          animationFrame = requestAnimationFrame(sample);
        };
        animationFrame = requestAnimationFrame(sample);
      }), { kind, reducedMotion, timeoutMs, observationMs }),
      // Keep the caller bounded even if the page's main thread cannot deliver
      // either its rendering callback or its own deadline timer.
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("GENERATION_MOTION_HARD_DEADLINE_EXCEEDED")), timeoutMs + 250);
      }),
    ]);
  } finally { clearTimeout(deadline); }
}
