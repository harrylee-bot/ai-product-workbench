import assert from "node:assert/strict";
import test from "node:test";

import { assertRouteTransitionFrames } from "./workbench-route-frame-contract.mjs";

test("accepts a mounted synchronized route transition when visible enter samples are coalesced", () => {
  const result = assertRouteTransitionFrames([
    frame({ home: route(1, "translateY(6px)"), homeHeader: route(1) }),
    frame({
      elapsedMs: 16,
      home: route(0.5, "translateY(3px)"),
      homeHeader: route(0.5),
      project: route(0),
      projectHeader: route(0),
      source: "mutation",
    }),
    frame({
      elapsedMs: 32,
      home: route(0),
      homeHeader: route(0),
      project: route(0.95),
      projectHeader: route(0.95),
    }),
    frame({ elapsedMs: 48, project: route(0.98), projectHeader: route(0.98) }),
    frame({ elapsedMs: 64, project: route(1), projectHeader: route(1) }),
  ], "home", "project", "coalesced Home-to-Project");

  assert.equal(result.overlapFrames, 2);
  assert.equal(result.visibleOverlapFrames, 0);
  assert.deepEqual(result.sourceOpacity, { maximum: 1, minimum: 0, range: 1 });
  assert.deepEqual(result.targetOpacity, { maximum: 1, minimum: 0, range: 1 });
  assert.deepEqual(result.homeTransforms, ["translateY(6px)", "translateY(3px)", "none"]);
});

test("ignores an unpainted mutation intermediate state when RAF samples remain visible", () => {
  const result = assertRouteTransitionFrames([
    frame({ home: route(1, "translateY(6px)"), homeHeader: route(1) }),
    frame({
      elapsedMs: 16,
      home: route(0),
      project: route(0),
      source: "mutation",
    }),
    frame({
      elapsedMs: 32,
      home: route(0.4, "translateY(3px)"),
      homeHeader: route(0.4),
      project: route(0.6),
      projectHeader: route(0.6),
    }),
    frame({ elapsedMs: 48, project: route(0.98), projectHeader: route(0.98) }),
    frame({ elapsedMs: 64, project: route(1), projectHeader: route(1) }),
  ], "home", "project", "mutation-coalesced Home-to-Project");

  assert.equal(result.mutationSamples, 1);
  assert.equal(result.paintCandidateFrames, 4);
});

test("rejects a serial route swap without any mounted overlap", () => {
  const frames = [
    frame({ home: route(1, "translateY(6px)"), homeHeader: route(1) }),
    frame({ elapsedMs: 16, home: route(0.5, "translateY(3px)"), homeHeader: route(0.5) }),
    frame({ elapsedMs: 32, project: route(0.2), projectHeader: route(0.2) }),
    frame({ elapsedMs: 48, project: route(0.7), projectHeader: route(0.6) }),
    frame({ elapsedMs: 64, project: route(1), projectHeader: route(1) }),
  ];

  assert.throws(
    () => assertRouteTransitionFrames(frames, "home", "project", "serial Home-to-Project"),
    /must mount outgoing and incoming route roots concurrently.*firstTarget/u,
  );
});

test("still rejects a mounted frame when both routes are visually blank", () => {
  const frames = [
    frame({ home: route(1, "translateY(6px)"), homeHeader: route(1) }),
    frame({ elapsedMs: 16, home: route(0), project: route(0) }),
    frame({ elapsedMs: 32, project: route(0.2), projectHeader: route(0.2) }),
    frame({ elapsedMs: 48, project: route(1), projectHeader: route(1) }),
  ];

  assert.throws(
    () => assertRouteTransitionFrames(frames, "home", "project", "blank Home-to-Project"),
    /must never expose a blank route frame/u,
  );
});

test("rejects a concurrently mounted route that never changes opacity", () => {
  const frames = [
    frame({ home: route(1, "translateY(6px)"), homeHeader: route(1) }),
    frame({
      elapsedMs: 16,
      home: route(0.5, "translateY(3px)"),
      homeHeader: route(0.5),
      project: route(1),
      projectHeader: route(1),
      source: "mutation",
    }),
    frame({ elapsedMs: 32, home: route(0), project: route(1), projectHeader: route(1) }),
    frame({ elapsedMs: 48, project: route(1), projectHeader: route(1) }),
  ];

  assert.throws(
    () => assertRouteTransitionFrames(frames, "home", "project", "snapped Home-to-Project"),
    /incoming project opacity must animate during enter/u,
  );
});

test("rejects an opacity transition that never changes the Home transform", () => {
  const frames = [
    frame({ home: route(1), homeHeader: route(1) }),
    frame({
      elapsedMs: 16,
      home: route(0.5),
      homeHeader: route(0.5),
      project: route(0),
      projectHeader: route(0),
      source: "mutation",
    }),
    frame({
      elapsedMs: 32,
      home: route(0),
      homeHeader: route(0),
      project: route(0.5),
      projectHeader: route(0.5),
    }),
    frame({ elapsedMs: 48, project: route(1), projectHeader: route(1) }),
  ];

  assert.throws(
    () => assertRouteTransitionFrames(frames, "home", "project", "static-transform Home-to-Project"),
    /must retain the Home root translate progression/u,
  );
});

function frame({
  elapsedMs = 0,
  home = absentRoute(),
  homeHeader = absentRoute(),
  project = absentRoute(),
  projectHeader = absentRoute(),
  source = "raf",
}) {
  return {
    elapsedMs,
    home,
    homeHeader,
    href: "http://127.0.0.1:3000/",
    label: "route-transition",
    project,
    projectHeader,
    source,
    stage: route(1),
  };
}

function route(opacity, transform = "none") {
  return {
    display: "block",
    elementId: 1,
    exists: true,
    hiddenByAncestor: false,
    inlineOpacity: String(opacity),
    opacity,
    transform,
    visibility: "visible",
    willChange: "opacity, transform",
    width: 100,
    height: 100,
  };
}

function absentRoute() {
  return { exists: false };
}
