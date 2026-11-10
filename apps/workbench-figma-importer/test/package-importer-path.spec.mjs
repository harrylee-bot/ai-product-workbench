import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRootFromModuleUrl } from "../scripts/package-importer-path.mjs";

describe("Figma importer package path resolution", () => {
  it("decodes spaces and non-ASCII mount names", () => {
  const cases = [
    "/tmp/workbench-fixture/apps/workbench-figma-importer/scripts/package-importer.mjs",
    "/Volumes/文件 /ai-product-workbench-runtime/source/apps/workbench-figma-importer/scripts/package-importer.mjs",
    "/tmp/中文 路径/apps/workbench-figma-importer/scripts/package-importer.mjs",
  ];

  for (const modulePath of cases) {
    const moduleUrl = pathToFileURL(modulePath).href;
    const expected = resolve(fileURLToPath(new URL("..", moduleUrl)));
    expect(packageRootFromModuleUrl(moduleUrl)).toBe(expected);
  }
  });

  it("does not depend on process.cwd", () => {
  const moduleUrl = pathToFileURL(
    "/Volumes/文件 /ai-product-workbench-runtime/source/apps/workbench-figma-importer/scripts/package-importer.mjs",
  ).href;
  const before = process.cwd();
  try {
    process.chdir("/");
    expect(
      packageRootFromModuleUrl(moduleUrl),
    ).toBe("/Volumes/文件 /ai-product-workbench-runtime/source/apps/workbench-figma-importer");
  } finally {
    process.chdir(before);
  }
  });
});
