import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaService } from "../../prisma/prisma.service";

type DependencyStatus = "ok" | "failed" | "skipped";

type DependencyCheck = {
  status: DependencyStatus;
  reason?: string;
};

@Injectable()
export class SystemReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async check() {
    const [database, storage, deerflow] = await Promise.all([
      this.checkDatabase(),
      this.checkStorage(),
      this.checkDeerFlow(),
    ]);
    const dependencies = { database, storage, deerflow };

    return {
      ok: Object.values(dependencies).every((item) => item.status !== "failed"),
      service: "ai-product-workbench-api",
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
      return { status: "ok" };
    } catch {
      return { status: "failed", reason: "database_unavailable" };
    }
  }

  private async checkStorage(): Promise<DependencyCheck> {
    const uploadRoot = path.resolve(
      this.config.get<string>("FILE_UPLOAD_ROOT") ?? path.resolve(process.cwd(), "storage/uploads"),
    );
    const probePath = path.join(uploadRoot, `.readiness-${randomUUID()}`);
    try {
      await mkdir(uploadRoot, { recursive: true });
      await access(uploadRoot, constants.R_OK | constants.W_OK);
      await writeFile(probePath, "ok", { flag: "wx" });
      await rm(probePath, { force: true });
      return { status: "ok" };
    } catch {
      await rm(probePath, { force: true }).catch(() => undefined);
      return { status: "failed", reason: "storage_unavailable" };
    }
  }

  private async checkDeerFlow(): Promise<DependencyCheck> {
    if (!readBoolean(this.config.get<string>("DEERFLOW_READINESS_REQUIRED"), false)) {
      return { status: "skipped" };
    }
    if (!readBoolean(this.config.get<string>("DEERFLOW_ENABLED"), false)) {
      return { status: "failed", reason: "deerflow_disabled" };
    }

    const gatewayUrl = this.config.get<string>("DEERFLOW_GATEWAY_URL")?.trim();
    const healthUrl = this.config.get<string>("DEERFLOW_HEALTH_URL")?.trim() ||
      (gatewayUrl ? `${gatewayUrl.replace(/\/$/, "")}/health` : undefined);
    if (!healthUrl) {
      return { status: "failed", reason: "deerflow_health_url_missing" };
    }

    const timeoutMs = Math.min(
      readPositiveInteger(this.config.get<string>("DEERFLOW_HEALTH_TIMEOUT_MS"), 2_000),
      10_000,
    );
    try {
      const internalToken = this.config.get<string>("DEER_FLOW_INTERNAL_AUTH_TOKEN")?.trim() ||
        this.config.get<string>("DEERFLOW_INTERNAL_AUTH_TOKEN")?.trim();
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(internalToken ? { "X-DeerFlow-Internal-Token": internalToken } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok
        ? { status: "ok" }
        : { status: "failed", reason: `deerflow_http_${response.status}` };
    } catch {
      return { status: "failed", reason: "deerflow_unavailable" };
    }
  }
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return value.trim().toLowerCase() === "true";
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
