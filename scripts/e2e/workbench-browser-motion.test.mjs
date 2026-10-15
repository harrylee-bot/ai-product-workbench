import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { captureGenerationMotion } from "./workbench-browser-motion.mjs";
import { waitForStableViewportLayout } from "./workbench-browser-viewport.mjs";

const fixture = `<!doctype html><style>
  #motion { width: 200px; height: 100px; position: relative; opacity: .64; }
  #motion::before { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg,red,blue);
    background-size: 200% 100%; animation: sweep 4.8s linear infinite, breath 4.8s ease-in-out infinite; }
  #motion.prototype::before { animation: slide 4.8s linear infinite; }
  #motion.paused::before { animation-play-state: paused; }
  #motion.frozen::before { background-position: 100% 0 !important; transform: none !important; }
  @keyframes sweep { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @keyframes breath { 0%,100% { opacity: .3; } 50% { opacity: .85; } }
  @keyframes slide { from { transform: translateX(-40%); } to { transform: translateX(40%); } }
  @keyframes jitter { 0%,100% { background-position: 0 0; } 50% { background-position: 100% 0; } }
  @keyframes transform-jitter { 0%,100% { transform: translateX(0); } 50% { transform: translateX(100px); } }
  @keyframes opacity-jitter { 0%,100% { opacity: .64; } 50% { opacity: .2; } }
  @media (prefers-reduced-motion: reduce) { #motion::before, #motion.prototype::before { animation-duration: .001s; animation-iteration-count: 1; } }
  #motion.jitter::before { animation: jitter .1s steps(2, end) infinite; }
  #motion.transform-jitter::before { animation: transform-jitter .1s steps(2, end) infinite; }
  #motion.element-transform-jitter { animation: transform-jitter .1s steps(2, end) infinite; }
  #motion.element-opacity-jitter { animation: opacity-jitter .1s steps(2, end) infinite; }
</style><div id="motion" data-canvas-generation-motion="prd" data-generation-stage="drafting-prd"></div>`;

test("production generation wash stays still with reduced motion during mount and phase changes", { timeout: 20_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const compiled = await build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { MotionPreferenceProvider } from "./apps/web/components/motion-preference-provider";
        import { ProjectStageMotionFX } from "./apps/web/components/workbench/workbench-project-chrome";
        const root = createRoot(document.querySelector("#root"));
        window.renderStage = (props) => flushSync(() => root.render(
          <MotionPreferenceProvider><ProjectStageMotionFX {...props} /></MotionPreferenceProvider>));`,
      resolveDir: process.cwd(), loader: "tsx",
    },
    tsconfig: "apps/web/tsconfig.json", bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env": "{}", "process.env.NODE_ENV": '"production"' },
  });
  const css = await readFile(new URL("../../apps/web/app/globals.css", import.meta.url), "utf8");
  for (const kind of ["prd", "prototype"]) {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    try {
      await page.setContent('<main id="root" class="workbench-shell"></main>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: compiled.outputFiles[0].text });
      const locator = page.locator(`[data-canvas-generation-motion="${kind}"]`);
      for (const phase of ["generating", "refining", "generating"]) {
        await page.evaluate((props) => window.renderStage(props), {
          motionKind: kind, generationStage: kind === "prd" ? "drafting-prd" : "generating-ui",
          phase, isOverview: false,
        });
        const result = await captureGenerationMotion(locator, { kind, reducedMotion: true });
        assert.deepEqual(result.frames[0], result.frames[1]);
        assert.equal(result.opacity, kind === "prd" ? "0.64" : phase === "refining" ? "0.62" : "0.48");
      }
      // Switching the operating-system preference must also take effect without
      // remounting the component or seeking any animations in the test.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await captureGenerationMotion(locator, { kind, reducedMotion: false });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const result = await captureGenerationMotion(locator, { kind, reducedMotion: true });
      assert.deepEqual(result.frames[0], result.frames[1]);
      // Real generation continues while users cross the mobile/tablet/desktop
      // breakpoints. Exercise those resizes after the preference switch too.
      for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(viewport);
        await waitForStableViewportLayout(page, viewport, { selectors: ["#root"] });
        await captureGenerationMotion(locator, { kind, reducedMotion: true });
      }
    } finally { await page.close(); }
  }
});

test("generation motion evidence follows real browser frames with bounded failure", { timeout: 20_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  async function reset(kind = "prd", reducedMotion = false, state = "") {
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    await page.setContent(fixture);
    await page.locator("#motion").evaluate((element, options) => {
      element.className = `${options.kind} ${options.state}`;
      element.setAttribute("data-canvas-generation-motion", options.kind);
    }, { kind, state });
    // The production caller also waits for responsive styles to reach stable
    // frames before observing animation; let the 1ms reduced animation settle.
    await page.locator("#motion").evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.ready));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    return page.locator("#motion");
  }

  await t.test("PRD and prototype normal motion advance on the original animation timeline", async () => {
    for (const kind of ["prd", "prototype"]) {
      const locator = await reset(kind);
      const before = await locator.evaluate((element) => ({
        html: element.outerHTML,
        animations: element.getAnimations({ subtree: true }).map((animation) => ({ name: animation.animationName, startTime: animation.startTime })),
      }));
      const result = await captureGenerationMotion(locator, { kind, reducedMotion: false });
      assert.equal(result.frames.length, 2);
      assert.ok(result.sampling.sampleCount >= 2);
      assert.ok(result.sampling.lastTimelineMs - result.sampling.firstTimelineMs >= 180);
      const key = kind === "prd" ? "beforeBackgroundPosition" : "beforeTransform";
      assert.notEqual(result.frames[0][key], result.frames[1][key]);
      assert.ok(result.beforeAnimationDuration.split(",").every((value) => value.trim() === "4.8s"));
      const after = await locator.evaluate((element) => ({
        html: element.outerHTML,
        animations: element.getAnimations({ subtree: true }).map((animation) => ({ name: animation.animationName, startTime: animation.startTime })),
      }));
      assert.deepEqual(after, before, "sampling must not rewrite the element or restart its animation");
    }
  });

  await t.test("a delayed rendering callback is observed without relying on a 180ms timer", async () => {
    const locator = await reset();
    await page.evaluate(() => {
      requestAnimationFrame(() => {
        const until = performance.now() + 240;
        while (performance.now() < until) { /* Simulate real main-thread layout work. */ }
      });
    });
    const result = await captureGenerationMotion(locator, { kind: "prd", reducedMotion: false });
    assert.notEqual(result.frames[0].beforeBackgroundPosition, result.frames[1].beforeBackgroundPosition);
    assert.ok(result.sampling.lastTimelineMs > result.sampling.firstTimelineMs);
  });

  await t.test("reduced motion is stable across the entire observation window", async () => {
    for (const kind of ["prd", "prototype"]) {
      const locator = await reset(kind, true);
      const result = await captureGenerationMotion(locator, { kind, reducedMotion: true });
      assert.ok(result.sampling.sampleCount > 2);
      assert.ok(result.sampling.lastTimelineMs - result.sampling.firstTimelineMs >= 180);
      assert.deepEqual(result.frames[0], result.frames[1]);
      assert.ok(result.beforeAnimationDuration.split(",").every((value) => value.trim() === "0.001s"));
    }
  });

  await t.test("paused animations and frozen rendered properties fail despite an advancing document clock", async () => {
    for (const state of ["paused", "frozen"]) {
      for (const kind of ["prd", "prototype"]) {
        const locator = await reset(kind, false, state);
        const startedAt = performance.now();
        await assert.rejects(captureGenerationMotion(locator, { kind, reducedMotion: false, timeoutMs: 250, observationMs: 80 }),
          /GENERATION_MOTION_(?:HARD_)?DEADLINE_EXCEEDED/u);
        assert.ok(performance.now() - startedAt < 1_500, "frozen animation observation must be bounded");
      }
    }
  });

  await t.test("reduced motion that moves and returns is rejected instead of comparing matching endpoints", async () => {
    const locator = await reset("prd", true, "jitter");
    await assert.rejects(captureGenerationMotion(locator, { kind: "prd", reducedMotion: true, timeoutMs: 700 }),
      /GENERATION_REDUCED_MOTION_MOVED/u);
  });

  await t.test("reduced motion rejects movement of every observed visual property", async () => {
    for (const [kind, state] of [
      ["prd", "transform-jitter"],
      ["prototype", "jitter"],
      ["prd", "element-transform-jitter"],
      ["prototype", "element-opacity-jitter"],
    ]) {
      const locator = await reset(kind, true, state);
      await assert.rejects(captureGenerationMotion(locator, { kind, reducedMotion: true, timeoutMs: 700 }),
        /GENERATION_REDUCED_MOTION_MOVED/u, `${kind} must detect ${state} throughout the observation window`);
    }
  });

  await t.test("a stage transition starts a fresh observation window without extending the deadline", async () => {
    const locator = await reset();
    await page.evaluate(() => {
      const original = window.requestAnimationFrame; let callbacks = 0;
      window.requestAnimationFrame = (callback) => original((time) => {
        if (++callbacks === 3) document.querySelector("#motion").setAttribute("data-generation-stage", "validating-prd");
        callback(time);
      });
    });
    const result = await captureGenerationMotion(locator, { kind: "prd", reducedMotion: false });
    assert.equal(result.sampling.generationStage, "validating-prd");
    assert.equal(result.sampling.stageResets, 1);
    assert.ok(result.sampling.lastTimelineMs - result.sampling.firstTimelineMs >= 180);
    assert.notEqual(result.frames[0].beforeBackgroundPosition, result.frames[1].beforeBackgroundPosition);
  });

  await t.test("detachment or a changed motion kind fails instead of sampling another element", async () => {
    for (const mutation of ["detach", "kind"]) {
      const locator = await reset();
      await page.evaluate((kind) => {
        const original = window.requestAnimationFrame; let callbacks = 0;
        window.requestAnimationFrame = (callback) => original((time) => {
          if (++callbacks === 3) {
            const element = document.querySelector("#motion");
            if (kind === "detach") element.remove();
            else element.setAttribute("data-canvas-generation-motion", "prototype");
          }
          callback(time);
        });
      }, mutation);
      await assert.rejects(captureGenerationMotion(locator, { kind: "prd", reducedMotion: false }),
        /GENERATION_MOTION_(?:ELEMENT_DETACHED|KIND_CHANGED)/u);
    }
  });

  await t.test("a stopped frame scheduler cannot keep the observation pending", async () => {
    const locator = await reset();
    await page.evaluate(() => { window.requestAnimationFrame = () => 1; });
    await assert.rejects(captureGenerationMotion(locator, { kind: "prd", reducedMotion: false, timeoutMs: 150, observationMs: 80 }),
      /GENERATION_MOTION_(?:HARD_)?DEADLINE_EXCEEDED/u);
    await page.close();
  });

  await t.test("the Node deadline also bounds a page which delivers neither frames nor timers", async () => {
    const stoppedPage = await browser.newPage();
    try {
      await stoppedPage.setContent(fixture);
      await stoppedPage.evaluate(() => { window.requestAnimationFrame = () => 1; window.setTimeout = () => 1; });
      const startedAt = performance.now();
      await assert.rejects(captureGenerationMotion(stoppedPage.locator("#motion"), { kind: "prd", reducedMotion: false, timeoutMs: 150, observationMs: 80 }),
        /GENERATION_MOTION_HARD_DEADLINE_EXCEEDED/u);
      assert.ok(performance.now() - startedAt < 1_500);
    } finally { await stoppedPage.close(); }
  });
});
