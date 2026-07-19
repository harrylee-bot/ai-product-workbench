"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type WorkbenchProjectSessionScope = {
  generation: number;
  projectId: string;
};

type WorkbenchProjectSessionLifecycle = {
  current: WorkbenchProjectSessionScope | null;
  mounted: boolean;
};

export type WorkbenchProjectSession = {
  generation: number;
  isCurrent: () => boolean;
  projectId: string;
  scope: WorkbenchProjectSessionScope;
};

export function useWorkbenchProjectSession(projectId: string): WorkbenchProjectSession {
  const [storedScope, setStoredScope] = useState<WorkbenchProjectSessionScope>(
    () => ({ generation: 1, projectId }),
  );
  let scope = storedScope;
  if (storedScope.projectId !== projectId) {
    scope = {
      generation: storedScope.generation + 1,
      projectId,
    };
    setStoredScope(scope);
  }
  const lifecycleRef = useRef<WorkbenchProjectSessionLifecycle>({
    current: null,
    mounted: false,
  });
  const lifecycle = lifecycleRef.current;

  useLayoutEffect(() => {
    lifecycle.current = scope;
    lifecycle.mounted = true;
    return () => {
      if (lifecycle.current === scope) {
        lifecycle.current = null;
        lifecycle.mounted = false;
      }
    };
  }, [lifecycle, scope]);

  return useMemo(() => ({
    generation: scope.generation,
    isCurrent: () => lifecycle.mounted && lifecycle.current === scope,
    projectId: scope.projectId,
    scope,
  }), [lifecycle, scope]);
}

type WorkbenchProjectState<T> = {
  scope: WorkbenchProjectSessionScope;
  value: T;
};

export function useWorkbenchProjectState<T>(
  session: WorkbenchProjectSession,
  createInitialValue: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  const [stored, setStored] = useState<WorkbenchProjectState<T>>(() => ({
    scope: session.scope,
    value: createInitialValue(),
  }));
  let rendered = stored;
  if (stored.scope !== session.scope) {
    rendered = {
      scope: session.scope,
      value: createInitialValue(),
    };
    setStored(rendered);
  }

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    if (!session.isCurrent()) return;
    setStored((current) => {
      if (!session.isCurrent() || current.scope !== session.scope) return current;
      const previous = current.value;
      const next = typeof action === "function"
        ? (action as (previous: T) => T)(previous)
        : action;
      if (Object.is(previous, next)) return current;
      return { scope: session.scope, value: next };
    });
  }, [session]);

  return [rendered.value, setValue];
}

export function useWorkbenchProjectRef<T>(
  session: WorkbenchProjectSession,
  createInitialValue: () => T,
): MutableRefObject<T> {
  const [stored, setStored] = useState<{
    ref: MutableRefObject<T>;
    scope: WorkbenchProjectSessionScope;
  }>(() => ({
    ref: { current: createInitialValue() },
    scope: session.scope,
  }));
  let rendered = stored;
  if (stored.scope !== session.scope) {
    rendered = {
      ref: { current: createInitialValue() },
      scope: session.scope,
    };
    setStored(rendered);
  }
  return rendered.ref;
}
