"use client";

import { useAnimationControls, useIsPresent } from "framer-motion";
import { useLayoutEffect } from "react";

import type { WorkbenchRouteView } from "./workbench-runtime-context";

const routeEnterTargets = {
  home: { opacity: 1, y: 0 },
  project: { opacity: 1 },
} as const;

export function useWorkbenchRouteEnterAnimation(routeView: WorkbenchRouteView) {
  const controls = useAnimationControls();
  const isPresent = useIsPresent();

  useLayoutEffect(() => {
    // AnimatePresence starts exits during layout. Start the incoming root in
    // that same phase so a delayed passive effect cannot leave both invisible.
    // A route restored before its exit finishes must also resume its entrance.
    if (isPresent) void controls.start(routeEnterTargets[routeView]);
  }, [controls, isPresent, routeView]);

  return controls;
}
