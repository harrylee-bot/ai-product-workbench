#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const entryPath = new URL(
  "integrations/deerflow/runtime-tools/runtime-result-validator.entry.ts",
  root,
);
const outputPath = new URL(
  "integrations/deerflow/runtime-tools/deerflow_workbench_tools/runtime_result_validator.bundle.mjs",
  root,
);
const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [fileURLToPath(entryPath)],
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
  process.stdout.write(`Wrote ${outputPath.pathname}\n`);
}
