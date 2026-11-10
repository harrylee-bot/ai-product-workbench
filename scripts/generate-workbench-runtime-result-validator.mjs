#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { build } from "esbuild";

// Convert file URLs through fileURLToPath so spaces and non-ASCII external-drive
// mount names remain valid filesystem paths on macOS and Windows.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = path.join(
  root,
  "integrations/deerflow/runtime-tools/runtime-result-validator.entry.ts",
);
const outputPath = path.join(
  root,
  "integrations/deerflow/runtime-tools/deerflow_workbench_tools/runtime_result_validator.bundle.mjs",
);
const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [entryPath],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
const generated = result.outputFiles?.[0]?.text;
if (!generated) throw new Error("Runtime result validator bundle was not generated");

if (check) {
  const current = await readFile(outputPath, "utf8").catch(() => null);
  if (current !== generated) {
    throw new Error("Runtime result validator bundle is stale; run npm run runtime:validator");
  }
  process.stdout.write("Runtime result validator bundle is current.\n");
} else {
  await writeFile(outputPath, generated, { encoding: "utf8", mode: 0o755 });
  process.stdout.write(`Wrote ${outputPath}\n`);
}
