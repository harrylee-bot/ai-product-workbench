import { checkFrozenPrototypeHtml } from "@workbench/workbench-build-worker";

// Loading the SDK loads its native core bridge. Do this in the real executor,
// before a health gateway can report ready or accept workflow commands.
await import("@temporalio/worker");
await import("@workbench/workbench-db");
await checkFrozenPrototypeHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Executor readiness</title></head><body><main data-wb-prototype="readiness"><section data-wb-screen="ready">原型构建就绪</section></main><script>document.querySelector('main').dataset.wbRuntimeInstalled='true';</script></body></html>`);
console.log("[prototype-temporal-worker] native bridge and Chromium probe passed");

if (process.argv[2] !== "--probe") await import("./temporal-worker-main.js");
