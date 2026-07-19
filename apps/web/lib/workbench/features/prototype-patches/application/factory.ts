"use client";

import { createWorkbenchPrototypePatchesApi } from "../api-adapter";
import {
  PrototypePatchProjectorStore,
  type PrototypePatchProjectorErrorContext,
} from "./projector-store";
import type { PrototypeCheckpointRecoveryOptions } from "./recovery";

export function createWorkbenchPrototypePatchProjector(options: {
  baseUrl: string;
  onError?: (error: unknown, context: PrototypePatchProjectorErrorContext) => void;
  recovery?: PrototypeCheckpointRecoveryOptions;
}): PrototypePatchProjectorStore {
  return new PrototypePatchProjectorStore({
    onError: options.onError,
    recovery: options.recovery,
    transport: createWorkbenchPrototypePatchesApi({ baseUrl: options.baseUrl }),
  });
}
