// This entry is used only by the isolated Studio browser acceptance suite.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLoopbackImportClient } from "./studio-live-import-upstream.mjs";

assert.equal(process.env.NODE_ENV, "test");
const db = new URL(process.env.WORKBENCH_DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(db.hostname) && /^\/workbench_studio_live_test_\d+$/u.test(db.pathname));
const root = pathToFileURL(path.resolve(process.cwd(), "apps/workbench-import-worker/dist") + path.sep);
const { SafeHttpClient } = await import(new URL("./fetch/safe-http-client.js", root));
const client = createLoopbackImportClient(SafeHttpClient, process.env.WORKBENCH_STUDIO_IMPORT_FIXTURE_ORIGIN);
// The production entry still creates its worker, database store, scanner,
// queue and S3 adapter. Only the client's upstream boundary is replaced here.
const fixtureGet = client.get.bind(client);
SafeHttpClient.prototype.get = fixtureGet;
await import(new URL("./main.js", root));
