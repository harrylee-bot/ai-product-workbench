export const workbenchEase = [0.16, 1, 0.3, 1] as const;

// A motion update subscriber keeps route opacity on Framer's main-thread driver,
// avoiding a one-frame WAAPI fallback to the initial value at animation handoff.
export const keepWorkbenchRouteMotionOnMainThread = () => undefined;

export const viewTransition = {
  duration: 0.24,
  ease: workbenchEase,
} as const;

export const popoverTransition = {
  duration: 0.15,
  ease: workbenchEase,
} as const;

export const panelTransition = {
  duration: 0.4,
  ease: workbenchEase,
} as const;

export const floatingToolScale: number[] = [0.96, 1.046, 1];

export const floatingToolTransition = {
  duration: 0.4,
  ease: workbenchEase,
  times: [0, 0.72, 1],
};

export const drawerTransition = {
  duration: 0.30,
  ease: workbenchEase,
} as const;
