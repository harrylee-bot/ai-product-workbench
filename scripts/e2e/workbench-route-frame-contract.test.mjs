import assert from "node:assert/strict";
import test from "node:test";

import { assertRouteTransitionFrames } from "./workbench-route-frame-contract.mjs";

test("accepts a mounted sync handoff when the first incoming sample is transparent", () => {
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
      project: route(0.2),
      projectHeader: route(0.2),
    }),
    frame({ elapsedMs: 48, project: route(0.7), projectHeader: route(0.6) }),
    frame({ elapsedMs: 64, project: route(1), projectHeader: route(1) }),
  ], "home", "project", "coalesced Home-to-Project");

  assert.equal(result.overlapFrames, 2);
  assert.equal(result.visibleOverlapFrames, 0);
  assert.deepEqual(result.sourceOpacity, { maximum: 1, minimum: 0.5, range: 0.5 });
  assert.deepEqual(result.targetOpacity, { maximum: 1, minimum: 0.2, range: 0.8 });
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
    frame({ elapsedMs: 16, home: route(0), project: route(0), source: "mutation" }),
    frame({ elapsedMs: 32, project: route(0.2), projectHeader: route(0.2) }),
    frame({ elapsedMs: 48, project: route(1), projectHeader: route(1) }),
  ];

  assert.throws(
    () => assertRouteTransitionFrames(frames, "home", "project", "blank Home-to-Project"),
    /must never expose a blank route frame/u,
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
