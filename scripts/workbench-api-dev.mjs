import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const WORKBENCH_API_ROOT = path.join(repoRoot, "apps/workbench-api");
export const WORKBENCH_API_TSCONFIG = path.join(
  WORKBENCH_API_ROOT,
  "tsconfig.build.json",
);
export const WORKBENCH_API_ENTRYPOINT = path.join(
  WORKBENCH_API_ROOT,
  "dist/main.js",
);

function diagnosticFormatHost(typescript, system) {
  return {
    getCanonicalFileName: (fileName) =>
      system.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    getCurrentDirectory: () => system.getCurrentDirectory(),
    getNewLine: () => system.newLine,
  };
}

export function createTypeScriptWatch({
  configPath = WORKBENCH_API_TSCONFIG,
  onBuildComplete,
  typescript = ts,
  system = typescript.sys,
  writeDiagnostic = (message) => process.stderr.write(message),
  writeStatus = (message) => process.stdout.write(message),
} = {}) {
  if (typeof onBuildComplete !== "function") {
    throw new TypeError("onBuildComplete must be a function");
  }

  const formatHost = diagnosticFormatHost(typescript, system);
  let buildDiagnostics = [];

  const reportDiagnostic = (diagnostic) => {
    buildDiagnostics.push(diagnostic);
    writeDiagnostic(typescript.formatDiagnostic(diagnostic, formatHost));
  };
  const reportWatchStatus = (diagnostic) => {
    const message = typescript.flattenDiagnosticMessageText(
      diagnostic.messageText,
      system.newLine,
    );
    writeStatus(`[api:build] ${message}${system.newLine}`);
  };

  const host = typescript.createWatchCompilerHost(
    configPath,
    {
      noEmit: false,
      noEmitOnError: true,
    },
    system,
    typescript.createEmitAndSemanticDiagnosticsBuilderProgram,
    reportDiagnostic,
    reportWatchStatus,
  );
  const emitAndReportDiagnostics = host.afterProgramCreate;

  host.afterProgramCreate = (builderProgram) => {
    buildDiagnostics = [];
    emitAndReportDiagnostics?.(builderProgram);

    const diagnostics = buildDiagnostics;
    const success = diagnostics.length === 0;
    onBuildComplete({
      builderProgram,
      diagnostics,
      success,
    });
  };

  return typescript.createWatchProgram(host);
}

export function createWorkbenchApiDevRunner({
  createCompilerWatch = createTypeScriptWatch,
  spawnRuntime = spawn,
  processTarget = process,
  logger = console,
  root = WORKBENCH_API_ROOT,
  runtimeCommand = process.execPath,
  runtimeArgs = ["--enable-source-maps", WORKBENCH_API_ENTRYPOINT],
  runtimeEnv = process.env,
  stopTimeoutMs = 5_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let watcher;
  let watcherClosed = false;
  let runtime;
  let restartQueue = Promise.resolve();
  let shutdownPromise;
  let resolveFinished;

  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  const isShuttingDown = () => shutdownPromise !== undefined;

  const closeWatcher = () => {
    if (watcherClosed) return;
    watcherClosed = true;
    try {
      watcher?.close();
    } catch (error) {
      logger.error("[api:dev] failed to close the TypeScript watcher:", error);
    }
  };

  const stopRuntime = async (signal) => {
    const activeRuntime = runtime;
    if (!activeRuntime || activeRuntime.closed) return;

    activeRuntime.stopping = true;
    const forceTimer = setTimeoutFn(() => {
      if (activeRuntime.closed) return;
      try {
        activeRuntime.child.kill("SIGKILL");
      } catch (error) {
        logger.error("[api:dev] failed to force-stop the API runtime:", error);
      }
    }, stopTimeoutMs);
    forceTimer.unref?.();

    try {
      activeRuntime.child.kill(signal);
      await activeRuntime.closedPromise;
    } catch (error) {
      logger.error("[api:dev] failed to stop the API runtime:", error);
    } finally {
      clearTimeoutFn(forceTimer);
      if (runtime === activeRuntime && activeRuntime.closed) runtime = undefined;
    }
  };

  const removeSignalListeners = () => {
    processTarget.off("SIGINT", onSigint);
    processTarget.off("SIGTERM", onSigterm);
  };

  const requestShutdown = (exitCode, signal) => {
    if (shutdownPromise) return shutdownPromise;

    closeWatcher();
    shutdownPromise = Promise.resolve().then(async () => {
      await restartQueue.catch(() => undefined);
      await stopRuntime(signal);
      removeSignalListeners();
      resolveFinished(exitCode);
      return exitCode;
    });
    return shutdownPromise;
  };

  const onSigint = () => {
    void requestShutdown(130, "SIGINT");
  };
  const onSigterm = () => {
    void requestShutdown(143, "SIGTERM");
  };

  const startRuntime = () => {
    const child = spawnRuntime(runtimeCommand, runtimeArgs, {
      cwd: root,
      env: runtimeEnv,
      stdio: "inherit",
    });
    let resolveClosed;
    const activeRuntime = {
      child,
      closed: false,
      closedPromise: new Promise((resolve) => {
        resolveClosed = resolve;
      }),
      stopping: false,
    };
    runtime = activeRuntime;

    child.once("error", (error) => {
      if (activeRuntime.stopping || isShuttingDown()) return;
      logger.error("[api:dev] API runtime failed:", error);
      void requestShutdown(1, "SIGTERM");
    });
    child.once("close", (code, signal) => {
      activeRuntime.closed = true;
      if (runtime === activeRuntime) runtime = undefined;
      resolveClosed({ code, signal });

      if (activeRuntime.stopping || isShuttingDown()) return;
      const exitCode = Number.isInteger(code) && code > 0 ? code : 1;
      logger.error(
        `[api:dev] API runtime stopped unexpectedly${
          signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`
        }.`,
      );
      void requestShutdown(exitCode, "SIGTERM");
    });

    logger.info("[api:dev] API runtime started from a successful build.");
  };

  const queueRuntimeRestart = () => {
    restartQueue = restartQueue
      .then(async () => {
        if (isShuttingDown()) return;
        await stopRuntime("SIGTERM");
        if (isShuttingDown()) return;
        startRuntime();
      })
      .catch((error) => {
        logger.error("[api:dev] failed to restart the API runtime:", error);
        void requestShutdown(1, "SIGTERM");
      });
  };

  processTarget.once("SIGINT", onSigint);
  processTarget.once("SIGTERM", onSigterm);

  try {
    watcher = createCompilerWatch({
      onBuildComplete: ({ success }) => {
        if (isShuttingDown()) return;
        if (!success) {
          logger.error("[api:dev] build failed; keeping the current API runtime.");
          return;
        }
        queueRuntimeRestart();
      },
    });
  } catch (error) {
    logger.error("[api:dev] failed to start the TypeScript watcher:", error);
    void requestShutdown(1, "SIGTERM");
  }

  return {
    close: () => requestShutdown(0, "SIGTERM"),
    finished,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const runner = createWorkbenchApiDevRunner();
  process.exitCode = await runner.finished;
}
