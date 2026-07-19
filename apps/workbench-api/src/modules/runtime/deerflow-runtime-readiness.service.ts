import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { tracedFetch } from "@workbench/workbench-telemetry";
import { z } from "zod";
import { RuntimeModelsService } from "./runtime-models.service.js";

const skillCatalogSchema = z.object({
  skills: z.array(z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    enabled: z.boolean(),
  }).passthrough()),
}).passthrough();

const MAX_SKILL_CATALOG_BYTES = 1_000_000;

@Injectable()
export class DeerFlowRuntimeReadinessService {
  private readonly catalogUrl: string;
  private readonly internalToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly models: RuntimeModelsService,
  ) {
    this.catalogUrl = `${configuredGatewayUrl(config)}/api/skills`;
    this.internalToken = requiredConfig(config, "DEERFLOW_INTERNAL_AUTH_TOKEN");
    this.timeoutMs = positiveIntegerConfig(config, "DEERFLOW_READINESS_TIMEOUT_MS", 5_000);
  }

  async assertReady(): Promise<void> {
    const [models] = await Promise.all([
      this.models.list(),
      this.assertPublicWorkbenchSkill(),
    ]);
    if (models.items.length === 0) throw new Error("DEERFLOW_MODEL_CATALOG_EMPTY");
  }

  private async assertPublicWorkbenchSkill(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await tracedFetch(this.catalogUrl, {
        headers: {
          accept: "application/json",
          "X-DeerFlow-Internal-Token": this.internalToken,
          "X-DeerFlow-Owner-User-Id": "workbench-readiness",
        },
        signal: controller.signal,
      }).catch(() => {
        throw new Error("DEERFLOW_SKILL_CATALOG_UNAVAILABLE");
      });
      if (!response.ok) throw new Error("DEERFLOW_SKILL_CATALOG_UNAVAILABLE");
      const text = await response.text().catch(() => {
        throw new Error("DEERFLOW_SKILL_CATALOG_UNAVAILABLE");
      });
      if (Buffer.byteLength(text) > MAX_SKILL_CATALOG_BYTES) {
        throw new Error("DEERFLOW_SKILL_CATALOG_INVALID");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("DEERFLOW_SKILL_CATALOG_INVALID");
      }
      const parsed = skillCatalogSchema.safeParse(payload);
      if (!parsed.success) throw new Error("DEERFLOW_SKILL_CATALOG_INVALID");
      const skill = parsed.data.skills.find((candidate) => candidate.name === "workbench");
      if (!skill || skill.category !== "public" || !skill.enabled) {
        throw new Error("DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function configuredGatewayUrl(config: ConfigService): string {
  const value = requiredConfig(config, "DEERFLOW_GATEWAY_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DEERFLOW_GATEWAY_URL must be an absolute URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DEERFLOW_GATEWAY_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DEERFLOW_GATEWAY_URL must not contain credentials, a query, or a fragment");
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
