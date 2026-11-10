import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { packageRootFromModuleUrl } from "./package-importer-path.mjs";

const root = packageRootFromModuleUrl(import.meta.url);
const outputDirectory = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const buildMain = await readFile(resolve(root, "build/main.js"));
const buildUi = await readFile(resolve(root, "build/ui.js"));
const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const archive = zipSync({
  "manifest.json": manifestBytes,
  "build/main.js": new Uint8Array(buildMain),
  "build/ui.js": new Uint8Array(buildUi),
}, { mtime: new Date("1980-01-01T00:00:00.000Z") });
const output = resolve(outputDirectory, "workbench-figma-importer-1.0.0.zip");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive);
console.log(output);
