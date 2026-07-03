import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ObsidianVaultService } from "./obsidian-vault.service";

@Injectable()
export class KnowledgeMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KnowledgeMaintenanceService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly vault: ObsidianVaultService) {}

  onModuleInit() {
    if (!readBooleanEnv("KNOWLEDGE_DAILY_SYNC_ENABLED", false)) return;
    const intervalMs = readNumberEnv("KNOWLEDGE_DAILY_SYNC_INTERVAL_MS", 86_400_000);
    this.timer = setInterval(() => {
      void this.runDailySync();
    }, intervalMs);
    this.timer.unref?.();

    if (readBooleanEnv("KNOWLEDGE_DAILY_SYNC_ON_STARTUP", false)) {
      const startupTimer = setTimeout(() => void this.runDailySync(), 1_000);
      startupTimer.unref?.();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runDailySync() {
    if (this.running) {
      this.logger.warn("Knowledge daily sync skipped because a previous sync is still running.");
      return { skipped: true, reason: "already_running" };
    }
    this.running = true;
    try {
      const result = await this.vault.syncToKnowledgeBase(systemKnowledgeUser());
      this.logger.log(`Knowledge daily sync completed: ${JSON.stringify(result)}`);
      return { skipped: false, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Knowledge daily sync failed: ${message}`, error instanceof Error ? error.stack : undefined);
      throw error;
    } finally {
      this.running = false;
    }
  }
}

function systemKnowledgeUser(): AuthenticatedUser {
  return {
    id: "system",
    username: "system",
    email: "system@example.local",
    displayName: "系统任务",
    role: UserRole.admin,
    status: UserStatus.active,
  };
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
