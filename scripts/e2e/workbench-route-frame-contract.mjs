export function assertRouteTransitionFrames(frames, from, to, label) {
  assert(frames.length >= 4, `${label} must capture multiple animation frames: ${frames.length}`);
  const stageFailures = frames.filter((frame) => !routePresent(frame.stage));
  assert(stageFailures.length === 0, `${label} must never hide or remove the Workbench stage`);
  const blankFrames = frames.filter((frame) => (
    !routePresent(frame.home) && !routePresent(frame.project)
  ));
  assert(
    blankFrames.length === 0,
    `${label} must never expose a blank route frame: ${JSON.stringify(
      routeFrameDiagnosticWindows(frames, blankFrames),
    )}`,
  );

  const sourceFrames = frames.filter((frame) => routePresent(frame[from]));
  const targetFrames = frames.filter((frame) => routePresent(frame[to]));
  const sourceMotionFrames = frames.filter((frame) => routeMounted(frame[from]));
  const targetMotionFrames = frames.filter((frame) => routeMounted(frame[to]));
  const mountedOverlapFrames = frames.filter((frame) => (
    routeMounted(frame[from]) && routeMounted(frame[to])
  ));
  const visibleOverlapFrames = frames.filter((frame) => (
    routePresent(frame[from]) && routePresent(frame[to])
  ));
  assert(sourceFrames.length > 0, `${label} must retain the outgoing ${from} root during exit`);
  assert(targetFrames.length > 0, `${label} must mount the incoming ${to} root`);
  assert(
    mountedOverlapFrames.length > 0,
    `${label} must mount outgoing and incoming route roots concurrently under AnimatePresence sync: ${JSON.stringify(
      routeHandoffDiagnostic(frames, from, to),
    )}`,
  );

  const sourceOpacity = opacityRange(sourceMotionFrames.map((frame) => frame[from]));
  const targetOpacity = opacityRange(targetMotionFrames.map((frame) => frame[to]));
  assert(sourceOpacity.maximum >= 0.95, `${label} outgoing ${from} must begin fully visible`);
  assert(sourceOpacity.range >= 0.12, `${label} outgoing ${from} opacity must animate during exit`);
  assert(targetOpacity.maximum >= 0.95, `${label} incoming ${to} must finish fully visible`);
  assert(targetOpacity.range >= 0.12, `${label} incoming ${to} opacity must animate during enter`);

  const lastTarget = [...frames].reverse().find((frame) => routePresent(frame[to]));
  assert(lastTarget?.[to].opacity >= 0.95, `${label} incoming ${to} must settle at opacity 1`);
  const childKey = to === "home" ? "homeHeader" : "projectHeader";
  const childOpacity = opacityRange(
    frames.filter((frame) => routeMounted(frame[childKey])).map((frame) => frame[childKey]),
  );
  assert(childOpacity.maximum >= 0.95, `${label} incoming ${to} header must finish visible`);
  assert(childOpacity.range >= 0.08, `${label} must retain the incoming ${to} child enter animation`);

  const homeTransforms = new Set(
    frames
      .filter((frame) => routePresent(frame.home))
      .map((frame) => frame.home.transform)
      .filter((value) => value && value !== "none"),
  );
  assert(homeTransforms.size >= 2, `${label} must retain the Home root translate progression`);

  return {
    elapsedMs: Math.round(frames.at(-1)?.elapsedMs ?? 0),
    frameCount: frames.length,
    mutationSamples: frames.filter((frame) => frame.source === "mutation").length,
    overlapFrames: mountedOverlapFrames.length,
    rafSamples: frames.filter((frame) => frame.source === "raf").length,
    sourceOpacity,
    targetChildOpacity: childOpacity,
    targetOpacity,
    visibleOverlapFrames: visibleOverlapFrames.length,
  };
}

export function routePresent(snapshot) {
  return routeMounted(snapshot)
    && Number.isFinite(snapshot.opacity)
    && snapshot.opacity > 0.001;
}

function routeMounted(snapshot) {
  return snapshot?.exists
    && !snapshot.hiddenByAncestor
    && snapshot.display !== "none"
    && snapshot.visibility !== "hidden"
    && snapshot.width > 0
    && snapshot.height > 0;
}

function opacityRange(snapshots) {
  const values = snapshots
    .map((snapshot) => snapshot.opacity)
    .filter((value) => Number.isFinite(value));
  assert(values.length > 0, "Route motion samples must contain numeric opacity values");
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return {
    maximum: Number(maximum.toFixed(3)),
    minimum: Number(minimum.toFixed(3)),
    range: Number((maximum - minimum).toFixed(3)),
  };
}

function routeFrameDiagnostic(frame) {
  return {
    elapsedMs: Number(frame.elapsedMs.toFixed(3)),
    home: frame.home,
    href: frame.href,
    project: frame.project,
    source: frame.source,
    stage: frame.stage,
  };
}

function routeFrameDiagnosticWindows(frames, failures) {
  return failures.map((failure) => {
    const index = frames.indexOf(failure);
    return {
      failureIndex: index,
      frames: frames
        .slice(Math.max(0, index - 2), index + 3)
        .map(routeFrameDiagnostic),
    };
  });
}

function routeHandoffDiagnostic(frames, from, to) {
  const firstTarget = frames.findIndex((frame) => routeMounted(frame[to]));
  const lastSource = frames.findLastIndex((frame) => routeMounted(frame[from]));
  const selected = new Set([0, frames.length - 1]);
  for (const pivot of [firstTarget, lastSource]) {
    if (pivot < 0) continue;
    for (let index = Math.max(0, pivot - 2); index <= Math.min(frames.length - 1, pivot + 2); index += 1) {
      selected.add(index);
    }
  }
  return {
    firstTarget,
    frameCount: frames.length,
    frames: [...selected]
      .sort((left, right) => left - right)
      .map((index) => ({ index, ...routeFrameDiagnostic(frames[index]) })),
    lastSource,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
