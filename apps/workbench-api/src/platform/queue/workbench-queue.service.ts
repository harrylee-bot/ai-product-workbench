import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@workbench/workbench-db";
import { traceQueuePublish } from "@workbench/workbench-telemetry";
import {
  assertImportSourceProcessQueueConfiguration,
  createAndAssertRuntimeQueues,
  exportBuildQueue,
  exportDeliveryQueue,
  exportDeliveryQueueOptions,
  fileExtractQueue,
  fileExtractQueueOptions,
  fileVerifyQueue,
  importSourceProcessQueue,
  importSourceProcessQueueOptions,
} from "@workbench/workbench-contracts";
import { fromPrisma, PgBoss, type SendOptions } from "pg-boss";

@Injectable()
export class WorkbenchQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkbenchQueueService.name);
  private readonly boss: PgBoss;

  constructor(config: ConfigService) {
    const rawConnectionString = config.getOrThrow<string>("WORKBENCH_DATABASE_URL");
    this.boss = new PgBoss({
      connectionString: pgConnectionString(rawConnectionString),
      schema: "workbench_jobs",
      application_name: "workbench-api",
      schedule: false,
      supervise: false,
      migrate: false,
      createSchema: false,
      useListenNotify: false,
    });
    this.boss.on("error", (error) => this.logger.error(error.message, error.stack));
  }

  async onModuleInit() {
    await this.boss.start();
    await createAndAssertRuntimeQueues(this.boss);
    await createAndAssertImportSourceQueue(this.boss);
    await this.boss.createQueue(fileVerifyQueue, {
      policy: "short",
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 10 * 60,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      notify: true,
    });
    await this.boss.createQueue(fileExtractQueue, fileExtractQueueOptions);
    await this.boss.createQueue(exportBuildQueue, {
      policy: "short",
      retryLimit: 3,
      retryDelay: 5,
      retryBackoff: true,
      retryDelayMax: 5 * 60,
      expireInSeconds: 15 * 60,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      notify: true,
    });
    await this.boss.createQueue(exportDeliveryQueue, exportDeliveryQueueOptions);
  }

  async onModuleDestroy() {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  async sendInTransaction(
    tx: Prisma.TransactionClient,
    name: string,
    data: object,
    options: Omit<SendOptions, "db"> = {},
  ) {
    const jobId = await traceQueuePublish(name, data, (tracedData) => this.boss.send(name, tracedData, {
      ...options,
      db: fromPrisma(tx),
    }));
    if (!jobId) throw new Error(`pg-boss rejected job for queue ${name}`);
    return jobId;
  }
}

export async function createAndAssertImportSourceQueue(
  manager: Pick<PgBoss, "createQueue" | "getQueue">,
) {
  await manager.createQueue(importSourceProcessQueue, importSourceProcessQueueOptions);
  assertImportSourceProcessQueueConfiguration(
    await manager.getQueue(importSourceProcessQueue),
  );
}

export function pgConnectionString(value: string) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url.toString();
}
