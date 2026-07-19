"use client";

import { AnimatePresence } from "framer-motion";
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

import type { WorkbenchRouteView } from "./workbench-runtime-context";

export function WorkbenchRouteTransition({
  children,
  onExitComplete,
  routeView,
}: {
  children: ReactNode;
  onExitComplete?: () => void;
  routeView: WorkbenchRouteView;
}) {
  if (!isValidElement(children)) {
    throw new Error("A Workbench page route must render one root React element");
  }

  const keyedRoute = cloneElement(children as ReactElement, { key: routeView });
  return (
    <AnimatePresence mode="sync" onExitComplete={onExitComplete}>
      {keyedRoute}
    </AnimatePresence>
  );
}
