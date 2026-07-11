import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileRecoveryService } from "../src/files/file-recovery.service";

describe("FileRecoveryService", () => {
  const values = new Map<string, string>();
  const config = { get: vi.fn((key: string) => values.get(key)) };
  const files = { failInterruptedParsingFiles: vi.fn() };
  const conversions = { recoverInterruptedJobs: vi.fn() };
  const service = new FileRecoveryService(config as never, files as never, conversions as never);

  beforeEach(() => {
    vi.clearAllMocks();
    values.clear();
    files.failInterruptedParsingFiles.mockResolvedValue({ count: 2 });
    conversions.recoverInterruptedJobs.mockResolvedValue({
      interruptedCount: 1,
      queuedCount: 3,
      resumedCount: 0,
      waitingCount: 3,
      deferredCount: 0,
    });
  });

  it("marks interrupted work and recovers a bounded queued set on startup", async () => {
    values.set("FILE_RECOVERY_MAX_QUEUED_CONVERSIONS", "7");

    await service.onApplicationBootstrap();

    expect(files.failInterruptedParsingFiles).toHaveBeenCalledOnce();
    expect(conversions.recoverInterruptedJobs).toHaveBeenCalledWith(7);
  });

  it("can be explicitly disabled", async () => {
    values.set("FILE_RECOVERY_ENABLED", "false");

    await service.onApplicationBootstrap();

    expect(files.failInterruptedParsingFiles).not.toHaveBeenCalled();
    expect(conversions.recoverInterruptedJobs).not.toHaveBeenCalled();
  });
});
