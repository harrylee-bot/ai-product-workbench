import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type { RuntimePort, RuntimeThreadMetadata } from "./runtime.port.js";

export class RuntimeBindingService {
  constructor(
    private readonly db: PrismaClient,
    private readonly runtime: RuntimePort,
  ) {}

  async ensure(threadId: string, metadata: RuntimeThreadMetadata, signal?: AbortSignal) {
    const existing = await this.db.runtimeBinding.findUnique({ where: { threadId } });
    if (existing) {
      if (existing.adapter !== this.runtime.adapter) {
        throw new Error(`RUNTIME_BINDING_ADAPTER_MISMATCH:${existing.adapter}`);
      }
      return existing;
    }

    const external = await this.runtime.createThread(metadata, signal);
    try {
      return await this.db.runtimeBinding.create({
        data: {
          threadId,
          adapter: this.runtime.adapter,
          externalThreadId: external.externalThreadId,
          metadata: external.metadata as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.db.runtimeBinding.findUnique({ where: { threadId } });
        if (raced?.adapter === this.runtime.adapter) return raced;
      }
      throw error;
    }
  }
}
