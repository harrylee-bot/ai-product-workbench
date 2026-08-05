import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  floatingToolScale,
  floatingToolTransition,
  menuItemTransition,
  panelTransition,
  popoverTransition,
  spatialTransition,
  tactileTransition,
} from "@/components/workbench/workbench-motion";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Workbench motion contract", () => {
  it("keeps the Evidence Bundle timing tokens exact", async () => {
    const css = await readFile(path.join(webRoot, "app/globals.css"), "utf8");

    expect(css).toMatch(/\.workbench-home-submit-spinner\s*\{\s*animation-duration:\s*1s;/u);
    expect(css).toMatch(/\.workbench-status-spinner\s*\{\s*animation-duration:\s*1s;/u);
    expect(css).not.toMatch(/\.workbench-agent-card\[data-prd-bodyless="true"\]/u);
    expect(css).toMatch(/\.workbench-agent-card--generating::before\s*\{[^}]*opacity:\s*0\.54;[^}]*animation:\s*workbench-agent-color-wash 4\.2s linear infinite;/u);
    expect(css).toMatch(/\.workbench-agent-card--generating \.workbench-agent-card-base-bg\s*\{[^}]*animation:\s*workbench-agent-surface-shift 4\.2s linear infinite;/u);
    expect(css).toMatch(/workbench-agent-border-orbit 3\.4s linear infinite/u);
    expect(css).toMatch(/workbench-stage-ellipsis 900ms steps\(4, end\) infinite/u);
    expect(css).toMatch(/workbench-skeleton-fade 2\.5s ease-in-out infinite/u);
    expect(css).toMatch(/workbench-screen-enter 500ms\s+linear\(/u);
    expect(css).toMatch(/workbench-screen-border-orbit 3\.4s linear 1/u);
    expect(css).toMatch(/transition-duration:\s*150ms !important/u);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/u);
    expect(css).toMatch(/animation-duration:\s*1ms !important;[\s\S]*animation-iteration-count:\s*1 !important;/u);
    expect(css).toMatch(/--workbench-surface-container:\s*rgb\(22 23 24\)/u);
    expect(css).toMatch(/--workbench-selection:\s*rgb\(113 104 246\)/u);
    expect(css).toMatch(/data-generation-stage="generating-ui"/u);
    expect(css).toMatch(/data-generation-stage="screen-streaming"/u);
    expect(css).toMatch(/data-generation-stage="collecting-prd-context"[^}]*animation-duration:\s*3\.8s/u);
    expect(css).toMatch(/data-generation-stage="structuring-prd"[^}]*animation-duration:\s*3\.2s/u);
    expect(css).toMatch(/data-generation-stage="drafting-prd"[^}]*animation-duration:\s*2\.5s/u);
    expect(css).toMatch(/data-generation-stage="validating-prd"[^}]*animation-duration:\s*4\.8s/u);
    expect(css).toMatch(/\.workbench-stage-phase-wash--prd\s*\{[^}]*contain:\s*paint;[^}]*will-change:\s*opacity;/u);
    expect(css).toMatch(/\.workbench-stage-phase-wash--prd::before\s*\{[\s\S]*?background-size:\s*200%\s+100%;[\s\S]*?workbench-stage-aurora-sweep\s+2\.5s\s+linear\s+infinite,[\s\S]*?workbench-stage-aurora-breath\s+2\.5s\s+ease-in-out\s+infinite;[\s\S]*?will-change:\s*background-position,\s*opacity;/u);
    expect(css).toMatch(/@keyframes\s+workbench-stage-aurora-sweep[\s\S]*?background-position:\s*200%\s+0[\s\S]*?background-position:\s*-200%\s+0/u);
    expect(css).toMatch(/@keyframes\s+workbench-stage-aurora-breath[\s\S]*?opacity:\s*0\.30[\s\S]*?opacity:\s*0\.85/u);
  });

  it("applies the user reduced-motion preference to every application route", async () => {
    const [layout, provider] = await Promise.all([
      readFile(path.join(webRoot, "app/layout.tsx"), "utf8"),
      readFile(path.join(webRoot, "components/motion-preference-provider.tsx"), "utf8"),
    ]);

    expect(layout).toContain("<MotionPreferenceProvider>");
    expect(provider).toContain('reducedMotion="user"');
  });

  it("keeps floating controls on the 400ms overshoot curve", () => {
    expect(panelTransition.duration).toBe(0.4);
    expect(floatingToolScale).toEqual([0.96, 1.046, 1]);
    expect(floatingToolTransition).toMatchObject({
      duration: 0.4,
      times: [0, 0.72, 1],
    });
  });

  it("exposes the shared interaction timing tokens", () => {
    expect(tactileTransition.duration).toBe(0.15);
    expect(popoverTransition.duration).toBe(0.15);
    expect(menuItemTransition.duration).toBe(0.2);
    expect(spatialTransition.duration).toBe(0.5);
  });
});
