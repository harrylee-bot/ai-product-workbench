import {
  canvasClientCommandAckSchema,
  canvasClientCommandListSchema,
  canvasClientStateSyncResponseSchema,
  type CanvasClientStateSyncRequest,
  type CanvasClientStateSyncResponse,
  type CanvasClientCommand,
  type CanvasClientCommandAck,
  type CanvasClientCommandAckRequest,
  type CanvasClientCommandList,
} from "@workbench/workbench-contracts";

import { workbenchApiErrorFromResponse } from "../../../api";
import { createWorkbenchFetch } from "../../../api";
import { parseContract } from "../../../transport/contracts";

export type CanvasAgentCommandTransport = {
  acknowledge: (
    projectId: string,
    commandId: string,
    ack: CanvasClientCommandAckRequest,
    signal: AbortSignal,
  ) => Promise<CanvasClientCommandAck>;
  list: (
    projectId: string,
    clientSessionId: string,
    projectSessionGeneration: number,
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<CanvasClientCommandList>;
  syncState: (
    projectId: string,
    state: CanvasClientStateSyncRequest,
    signal: AbortSignal,
  ) => Promise<CanvasClientStateSyncResponse>;
};

export type CanvasAgentCommandTransportOptions = {
  baseUrl: string;
  fetch?: (request: Request) => Promise<Response>;
};

export class WorkbenchCanvasAgentCommandApi implements CanvasAgentCommandTransport {
  readonly #baseUrl: string;
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(options: CanvasAgentCommandTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#fetch = createWorkbenchFetch({ fetch: options.fetch });
  }

  async list(
    projectId: string,
    clientSessionId: string,
    projectSessionGeneration: number,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<CanvasClientCommandList> {
    const query = new URLSearchParams({
      clientSessionId,
      projectSessionGeneration: String(projectSessionGeneration),
      limit: "100",
    });
    if (cursor) query.set("after", cursor);
    const response = await this.#fetch(new Request(
      `${this.#baseUrl}/projects/${encodeURIComponent(projectId)}/canvas-agent/commands?${query}`,
      {
        method: "GET",
        headers: { Accept: "application/json, application/problem+json" },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      },
    ));
    await throwForCanvasAgentResponse(response);
    return parseContract(
      canvasClientCommandListSchema,
      await response.json(),
      "list Canvas Agent client commands",
    );
  }

  async acknowledge(
    projectId: string,
    commandId: string,
    ack: CanvasClientCommandAckRequest,
    signal: AbortSignal,
  ): Promise<CanvasClientCommandAck> {
    const response = await this.#fetch(new Request(
      `${this.#baseUrl}/projects/${encodeURIComponent(projectId)}/canvas-agent/commands/${encodeURIComponent(commandId)}/ack`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, application/problem+json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(ack),
        signal,
      },
    ));
    await throwForCanvasAgentResponse(response);
    return parseContract(
      canvasClientCommandAckSchema,
      await response.json(),
      "acknowledge Canvas Agent client command",
    );
  }

  async syncState(
    projectId: string,
    state: CanvasClientStateSyncRequest,
    signal: AbortSignal,
  ): Promise<CanvasClientStateSyncResponse> {
    signal.throwIfAborted();
    const response = await this.#fetch(new Request(
      `${this.#baseUrl}/projects/${encodeURIComponent(projectId)}/canvas-agent/state`,
      {
        method: "PUT",
        headers: {
          Accept: "application/json, application/problem+json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(state),
      },
    ));
    await throwForCanvasAgentResponse(response);
    return parseContract(
      canvasClientStateSyncResponseSchema,
      await response.json(),
      "synchronize Canvas Agent client state",
    );
  }
}

export function createWorkbenchCanvasAgentCommandApi(
  options: CanvasAgentCommandTransportOptions,
): WorkbenchCanvasAgentCommandApi {
  return new WorkbenchCanvasAgentCommandApi(options);
}

async function throwForCanvasAgentResponse(response: Response): Promise<void> {
  if (!response.ok) throw await workbenchApiErrorFromResponse(response);
}

export type { CanvasClientCommand };
