import { prismaReadyObjectIntegrityRecorder } from "@workbench/workbench-content-security";
import { BrowserExportService } from "../../src/browser/browser-export.service.js";
import { loadExportWorkerConfig } from "../../src/config.js";
import { ExportProcessor } from "../../src/export/export.processor.js";
import { PrismaExportStore } from "../../src/export/export.store.js";
import { ExportSourceLoader } from "../../src/export/source-loader.js";
import { S3ExportStorageAdapter } from "../../src/storage/s3-export-storage.adapter.js";
import { PrismaClient } from "@workbench/workbench-db";

function report(kind: string, details: Record<string, unknown> = {}) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("The audit holder needs an IPC channel"));
      return;
    }
    process.send({ kind, pid: process.pid, at: new Date().toISOString(), ...details }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  const [exportJobId, scenario] = process.argv.slice(2);
  if (!exportJobId || !["live", "expired"].includes(scenario ?? "")) throw new Error("Missing audit scenario");
  const config = loadExportWorkerConfig();
  const db = new PrismaClient({datasourceUrl: config.databaseUrl});
  const gate = Promise.withResolvers<void>();
  const release = (message: unknown) => { if (message === "release-cleanup") gate.resolve(); };
  const controller = new AbortController();
  const stop = () => {
    gate.resolve();
    controller.abort(new Error("Audit process shutting down"));
  };
  process.on("message", release);
  process.once("SIGTERM", stop);
  process.once("disconnect", stop);
  try {
    const store = new PrismaExportStore(db, config);
    const storage = new S3ExportStorageAdapter(config, prismaReadyObjectIntegrityRecorder(db));
    const realPut = storage.putVerified.bind(storage);
    storage.putVerified = async (identity, bytes, signal) => {
      try {
        return await realPut(identity, bytes, signal);
      } catch (error) {
        const reason = signal?.reason instanceof Error ? signal.reason.message : null;
        await report("storage-interrupted", {
          aborted: signal?.aborted ?? false,
          reasonCode: reason?.match(/EXPORT_[A-Z_]+/)?.[0] ?? null,
          errorName: error instanceof Error ? error.name : null,
          storageKey: identity.storageKey,
          sha256: identity.sha256,
        });
        await gate.promise;
        throw error;
      }
    };
    const browser = new BrowserExportService(config);
    const validate = browser.validateHtml.bind(browser);
    browser.validateHtml = async (...args) => {
      await validate(...args);
      await report("chromium-validated");
    };
    const processor = new ExportProcessor(store, new ExportSourceLoader(storage, config), storage, browser, config);
    const result = await processor.process(exportJobId, controller.signal, { retryCount: 0, retryLimit: 0 }, "audit-holder:" + process.pid);
    await report("processor-result", { result });
  } finally {
    await db.$disconnect();
    process.off("message", release);
    process.off("SIGTERM", stop);
    process.off("disconnect", stop);
  }
}

void main().catch(async (error) => {
  process.exitCode = 1;
  await report("process-error", { message: error instanceof Error ? error.stack : String(error) });
}).finally(() => {
  if (process.connected) process.disconnect();
});
