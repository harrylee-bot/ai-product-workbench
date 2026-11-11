"use client";

import type { Board } from "@workbench/workbench-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  createBoardStore,
  revisionEtag,
  type BoardConflictResolution,
  type BoardSaveSnapshot,
  type BoardAutosaveResult,
  type BoardStore,
} from "../domain";
import { workbenchQueryKeys } from "../../../query/keys";
import type { Versioned } from "../../../transport/contracts";
import { isWorkbenchApiError } from "../../../api/problem-details";
import { useWorkbenchBoardApi } from "../api-adapter";

export function useWorkbenchBoardController(projectId: string) {
  const service = useWorkbenchBoardApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: workbenchQueryKeys.board(projectId),
    queryFn: () => service.getBoard(projectId),
    enabled: Boolean(projectId),
  });
  const storeRef = useRef<BoardStore | null>(null);
  if (storeRef.current && storeRef.current.getState().projectId !== projectId) {
    storeRef.current = null;
  }
  if (!storeRef.current && query.data) {
    storeRef.current = createBoardStore(query.data.value, query.data.etag);
  }
  const store = storeRef.current;

  useEffect(() => {
    if (store && query.data) {
      store.getState().reconcileFromServer(query.data.value, query.data.etag);
    }
  }, [query.data, store]);

  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  const getSnapshot = useCallback(() => store?.getState() ?? null, [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const persistSnapshot = useCallback(
    async (snapshot: BoardSaveSnapshot) => {
      try {
        return await service.replaceBoard(
          snapshot.projectId,
          snapshot.request,
          snapshot.ifMatch,
          snapshot.idempotencyKey,
        );
      } catch (error) {
        if (isWorkbenchApiError(error) && error.status === 412 && error.code === "REVISION_CONFLICT") {
          // A generated Artifact can advance the Board after the last SSE
          // refresh. Reuse the store's guarded merge; content edits continue
          // to require an explicit conflict decision.
          try {
            const latest = await service.getBoard(snapshot.projectId);
            const canonical = queryClient.setQueryData<Versioned<Board>>(
              workbenchQueryKeys.board(snapshot.projectId),
              (current) => current && current.value.revision > latest.value.revision ? current : latest,
            )!;
            const currentStore = storeRef.current;
            if (currentStore?.getState().projectId === snapshot.projectId
              && canonical.value.revision >= currentStore.getState().serverRevision) {
              currentStore.getState().reconcileFromServer(canonical.value, canonical.etag);
            }
          } catch {
            // Keep the original CAS failure and the unsaved local snapshot.
          }
        }
        throw error;
      }
    },
    [queryClient, service],
  );
  const publishSavedSnapshot = useCallback(async (
    result: BoardAutosaveResult,
    snapshot: BoardSaveSnapshot,
  ) => {
    const versionedResult: Versioned<Board> = {
      value: result.value,
      etag: result.etag ?? revisionEtag(result.value.revision),
    };
    queryClient.setQueryData(workbenchQueryKeys.board(snapshot.projectId), versionedResult);
    await queryClient.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstrap(snapshot.projectId),
    });
  }, [queryClient]);

  const saveMutation = useMutation({
    mutationKey: [...workbenchQueryKeys.board(projectId), "save"],
    mutationFn: ({ snapshot }: { store: BoardStore; snapshot: BoardSaveSnapshot }) =>
      persistSnapshot(snapshot),
    async onSuccess(result, variables) {
      variables.store.getState().completeSave(variables.snapshot, result.value, result.etag);
      await publishSavedSnapshot(result, variables.snapshot);
    },
    onError(error, variables) {
      variables.store.getState().failSave(variables.snapshot, error);
    },
  });

  const save = useCallback(async () => {
    if (!store) return null;
    const snapshot = store.getState().prepareSave();
    if (!snapshot) return null;
    return saveMutation.mutateAsync({ store, snapshot });
  }, [saveMutation, store]);

  const resolveConflict = useCallback(async (resolution: BoardConflictResolution) => {
    if (!store) throw new Error("The Project Board is not ready");
    const latest = await service.getBoard(projectId);
    store.getState().resolveConflictFromServer(latest.value, resolution, latest.etag);
    queryClient.setQueryData(workbenchQueryKeys.board(projectId), latest);
    if (resolution === "discard-local") return latest;

    const snapshot = store.getState().prepareSave();
    if (!snapshot) throw new Error("The local Board could not be prepared for conflict replay");
    return saveMutation.mutateAsync({ store, snapshot });
  }, [projectId, queryClient, saveMutation, service, store]);
  const discardLocalConflict = useCallback(
    () => resolveConflict("discard-local"),
    [resolveConflict],
  );
  const replayLocalConflict = useCallback(
    () => resolveConflict("replay-local"),
    [resolveConflict],
  );

  return {
    query,
    persistSnapshot,
    publishSavedSnapshot,
    store,
    state,
    save,
    saveMutation,
    discardLocalConflict,
    replayLocalConflict,
    reload: query.refetch,
  };
}
