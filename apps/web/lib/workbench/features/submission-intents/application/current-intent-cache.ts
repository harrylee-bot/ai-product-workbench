import type {
  CurrentSubmissionIntent,
  SubmissionIntent,
} from "@workbench/workbench-contracts";
import type { QueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import type { Versioned } from "../../../transport/contracts";

type CurrentIntentGate = {
  controller: AbortController | null;
  readEpoch: number;
  writeEpoch: number;
};

const gatesByClient = new WeakMap<QueryClient, Map<string, CurrentIntentGate>>();

export async function replaceCurrentWorkbenchSubmissionIntent(
  queryClient: QueryClient,
  threadId: string,
  current: CurrentSubmissionIntent,
  versionedIntent?: Versioned<SubmissionIntent>,
): Promise<boolean> {
  const gate = currentIntentGate(queryClient, threadId);
  const writeEpoch = ++gate.writeEpoch;
  gate.readEpoch += 1;
  gate.controller?.abort();
  gate.controller = null;
  const queryKey = workbenchQueryKeys.currentSubmissionIntent(threadId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  if (gate.writeEpoch !== writeEpoch) return false;
  writeCurrentIntentCache(queryClient, threadId, current, versionedIntent);
  return true;
}

export async function refreshCurrentWorkbenchSubmissionIntent(
  queryClient: QueryClient,
  threadId: string,
  load: (signal: AbortSignal) => Promise<CurrentSubmissionIntent>,
): Promise<CurrentSubmissionIntent | undefined> {
  const gate = currentIntentGate(queryClient, threadId);
  const readEpoch = ++gate.readEpoch;
  const writeEpoch = gate.writeEpoch;
  gate.controller?.abort();
  const controller = new AbortController();
  gate.controller = controller;
  const queryKey = workbenchQueryKeys.currentSubmissionIntent(threadId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  if (
    controller.signal.aborted
    || gate.readEpoch !== readEpoch
    || gate.writeEpoch !== writeEpoch
  ) return undefined;
  const updateCount = queryClient.getQueryState<CurrentSubmissionIntent>(queryKey)
    ?.dataUpdateCount ?? 0;

  let current: CurrentSubmissionIntent;
  try {
    current = await load(controller.signal);
  } catch (error) {
    if (
      controller.signal.aborted
      || gate.readEpoch !== readEpoch
      || gate.writeEpoch !== writeEpoch
    ) return undefined;
    throw error;
  } finally {
    if (gate.controller === controller) gate.controller = null;
  }

  if (
    controller.signal.aborted
    || gate.readEpoch !== readEpoch
    || gate.writeEpoch !== writeEpoch
  ) return undefined;
  const latestState = queryClient.getQueryState<CurrentSubmissionIntent>(queryKey);
  if ((latestState?.dataUpdateCount ?? 0) !== updateCount) return latestState?.data;
  writeCurrentIntentCache(queryClient, threadId, current);
  return current;
}

function currentIntentGate(queryClient: QueryClient, threadId: string): CurrentIntentGate {
  let clientGates = gatesByClient.get(queryClient);
  if (!clientGates) {
    clientGates = new Map();
    gatesByClient.set(queryClient, clientGates);
  }
  let gate = clientGates.get(threadId);
  if (!gate) {
    gate = { controller: null, readEpoch: 0, writeEpoch: 0 };
    clientGates.set(threadId, gate);
  }
  return gate;
}

function writeCurrentIntentCache(
  queryClient: QueryClient,
  threadId: string,
  current: CurrentSubmissionIntent,
  versionedIntent?: Versioned<SubmissionIntent>,
) {
  queryClient.setQueryData(workbenchQueryKeys.currentSubmissionIntent(threadId), current);
  const detail = versionedIntent
    ?? (current.item
      ? { value: current.item, etag: `"${current.item.revision}"` }
      : null);
  if (detail) {
    queryClient.setQueryData(
      workbenchQueryKeys.submissionIntent(detail.value.id),
      detail,
    );
  }
}
