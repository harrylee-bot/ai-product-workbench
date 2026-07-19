"use client";

import {
  runPrototypePatchCheckpointSchema,
  type RunPrototypePatchCheckpoint,
} from "@workbench/workbench-contracts";

import {
  createWorkbenchFetch,
  workbenchApiErrorFromResponse,
} from "../../../api";
import { parseContract } from "../../../transport/contracts";

export type PrototypePatchCheckpointTransport = {
  getCheckpoint: (
    runId: string,
    artifactVersionId: string,
    signal: AbortSignal,
    screenId?: string,
  ) => Promise<RunPrototypePatchCheckpoint>;
};

export type WorkbenchPrototypePatchesApiOptions = {
  baseUrl: string;
  fetch?: (request: Request) => Promise<Response>;
};

export class WorkbenchPrototypePatchesApi implements PrototypePatchCheckpointTransport {
  readonly #baseUrl: string;
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(options: WorkbenchPrototypePatchesApiOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetch = createWorkbenchFetch({ fetch: options.fetch });
  }

  async getCheckpoint(
    runId: string,
    artifactVersionId: string,
    signal: AbortSignal,
    screenId?: string,
  ): Promise<RunPrototypePatchCheckpoint> {
    const query = screenId === undefined
      ? ""
      : `?${new URLSearchParams({ screenId })}`;
    const response = await this.#fetch(new Request(
      `${this.#baseUrl}/runs/${encodeURIComponent(runId)}/artifact-drafts/${encodeURIComponent(artifactVersionId)}/checkpoint${query}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json, application/problem+json",
          "Cache-Control": "no-cache",
        },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      },
    ));
    if (!response.ok) throw await workbenchApiErrorFromResponse(response);
    return parseContract(
      runPrototypePatchCheckpointSchema,
      await response.json(),
      "get Run Prototype patch checkpoint",
    );
  }
}

export function createWorkbenchPrototypePatchesApi(
  options: WorkbenchPrototypePatchesApiOptions,
): WorkbenchPrototypePatchesApi {
  return new WorkbenchPrototypePatchesApi(options);
}
