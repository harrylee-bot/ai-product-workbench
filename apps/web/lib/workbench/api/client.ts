import createClient, { type Client, type Middleware } from "openapi-fetch";

import {
  getWorkbenchApiBaseUrl,
  normalizeWorkbenchApiBaseUrl,
} from "./config";
import { workbenchApiErrorFromResponse } from "./problem-details";
import { createWorkbenchFetch } from "./request-fetch";
import type { paths } from "./schema";

export type WorkbenchApiClient = Client<paths>;

export type CreateWorkbenchApiClientOptions = {
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
};

export function createWorkbenchApiClient({
  baseUrl = getWorkbenchApiBaseUrl(),
  fetch,
}: CreateWorkbenchApiClientOptions = {}): WorkbenchApiClient {
  const client = createClient<paths>({
    baseUrl: normalizeWorkbenchApiBaseUrl(baseUrl),
    credentials: "same-origin",
    fetch: createWorkbenchFetch({ fetch }),
    headers: { Accept: "application/json, application/problem+json" },
  });

  client.use(problemDetailsMiddleware);
  return client;
}

const problemDetailsMiddleware: Middleware = {
  async onResponse({ response }) {
    if (!response.ok && response.status !== 304) {
      throw await workbenchApiErrorFromResponse(response);
    }
  },
};
