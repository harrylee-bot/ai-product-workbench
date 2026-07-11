import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, throwError } from "rxjs";
import { describe, expect, it } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TempFileCleanupInterceptor } from "../src/files/temp-file-cleanup.interceptor";

describe("TempFileCleanupInterceptor", () => {
  it("removes files left by Multer when downstream validation rejects the request", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workbench-multer-cleanup-"));
    const filePath = path.join(dir, "upload.tmp");
    await writeFile(filePath, "payload");
    const request = { files: [{ path: filePath }] };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const next = {
      handle: () => throwError(() => new Error("validation failed")),
    } as CallHandler;

    const result = lastValueFrom(new TempFileCleanupInterceptor().intercept(context, next));

    await expect(result).rejects.toThrow("validation failed");
    await expect(stat(filePath)).rejects.toThrow();
  });
});
