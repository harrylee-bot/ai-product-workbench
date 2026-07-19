import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  runWorkflowSchema,
  runtimeModelListSchema,
  type RunWorkflow,
  type RuntimeModelList,
} from "@workbench/workbench-contracts";
import { tracedFetch } from "@workbench/workbench-telemetry";
import { z } from "zod";
import {
  runtimeModelCatalogTimeoutProblem,
  runtimeModelCatalogUnavailableProblem,
  runtimeModelNotFoundProblem,
  validationProblem,
} from "../../common/problem-details.js";

const supportedWorkflows = [...runWorkflowSchema.options];

const deerFlowModelSchema = z.object({
  name: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  display_name: z.string().min(1).max(240).nullable(),
  description: z.string().max(4_000).nullable(),
  supports_thinking: z.boolean(),
  supports_reasoning_effort: z.boolean(),
}).strict();

const deerFlowModelCatalogSchema = z.object({
  models: z.array(deerFlowModelSchema).max(200),
  token_usage: z.object({ enabled: z.boolean() }).strict(),
}).strict();

@Injectable()
export class RuntimeModelsService {
  private readonly catalogUrl: string;
  private readonly internalToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.catalogUrl = `${configuredBaseUrl(config)}/models`;
    this.internalToken = requiredConfig(config, "DEERFLOW_INTERNAL_AUTH_TOKEN");
    this.timeoutMs = positiveIntegerConfig(config, "DEERFLOW_MODEL_CATALOG_TIMEOUT_MS", 5_000);
  }

  async list(): Promise<RuntimeModelList> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await tracedFetch(this.catalogUrl, {
          method: "GET",
          headers: {
            accept: "application/json",
            "X-DeerFlow-Internal-Token": this.internalToken,
          },
          signal: controller.signal,
        });
      } catch {
        if (timedOut) throw runtimeModelCatalogTimeoutProblem();
        throw runtimeModelCatalogUnavailableProblem();
      }

      if (!response.ok) throw runtimeModelCatalogUnavailableProblem();

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (timedOut) throw runtimeModelCatalogTimeoutProblem();
        throw runtimeModelCatalogUnavailableProblem();
      }

      const upstream = deerFlowModelCatalogSchema.safeParse(payload);
      if (!upstream.success) throw runtimeModelCatalogUnavailableProblem();

      const result = runtimeModelListSchema.safeParse({
        items: upstream.data.models.map((model) => ({
          id: model.name,
          displayName: model.display_name ?? model.name,
          description: model.description,
          supportedWorkflows,
          supportsThinking: model.supports_thinking,
          supportsReasoningEffort: model.supports_reasoning_effort,
        })),
      });
      if (!result.success) throw runtimeModelCatalogUnavailableProblem();
      return result.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async assertAvailable(modelId: string, workflow: RunWorkflow): Promise<void> {
    const catalog = await this.list();
    const model = catalog.items.find((candidate) => candidate.id === modelId);
    if (!model) throw runtimeModelNotFoundProblem();
    if (!model.supportedWorkflows.includes(workflow)) {
      throw validationProblem(
        "The selected runtime model does not support the requested workflow",
        { workflow: [`${modelId} does not support ${workflow}`] },
      );
    }
  }
}

function configuredBaseUrl(config: ConfigService): string {
  const value = requiredConfig(config, "DEERFLOW_LANGGRAPH_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DEERFLOW_LANGGRAPH_URL must be an absolute URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DEERFLOW_LANGGRAPH_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DEERFLOW_LANGGRAPH_URL must not contain credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function requiredConfig(config: ConfigService, name: string): string {
  const value = config.get<string>(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function positiveIntegerConfig(config: ConfigService, name: string, fallback: number): number {
  const value = config.get<string>(name)?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 60_000) {
    throw new Error(`${name} must be an integer between 1 and 60000`);
  }
  return parsed;
}
