"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

import {
  type PrototypePatchProjectionView,
  PrototypePatchProjectorStore,
} from "./projector-store";

const PrototypePatchProjectionContext = createContext<PrototypePatchProjectorStore | null>(null);

export function PrototypePatchProjectionProvider({
  children,
  projector,
}: {
  children: ReactNode;
  projector: PrototypePatchProjectorStore;
}) {
  return (
    <PrototypePatchProjectionContext.Provider value={projector}>
      {children}
    </PrototypePatchProjectionContext.Provider>
  );
}

export function usePrototypePatchProjection(
  artifactVersionId: string,
  screenId: string | undefined,
): PrototypePatchProjectionView | null {
  const projector = useContext(PrototypePatchProjectionContext);
  const subscribe = useCallback((listener: () => void) => (
    projector && screenId
      ? projector.subscribeProjection(artifactVersionId, screenId, listener)
      : () => undefined
  ), [artifactVersionId, projector, screenId]);
  const getSnapshot = useCallback(() => (
    projector && screenId
      ? projector.getProjectionSnapshot(artifactVersionId, screenId)
      : null
  ), [artifactVersionId, projector, screenId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePrototypePatchProjector(): PrototypePatchProjectorStore | null {
  return useContext(PrototypePatchProjectionContext);
}
