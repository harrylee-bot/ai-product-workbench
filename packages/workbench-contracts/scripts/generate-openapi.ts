import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import YAML from "yaml";
import { z } from "zod";

const outputPath = fileURLToPath(new URL("../openapi/workbench.v1.yaml", import.meta.url));

async function main() {
  extendZodWithOpenApi(z);
  const { buildWorkbenchOpenApiDocument } = await import("../src/openapi-document.js");
  const document = buildWorkbenchOpenApiDocument();
  const generated = [
    "# Generated from Workbench Zod schemas and the explicit route registry. Do not edit.",
    YAML.stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }),
  ].join("\n");

  if (process.argv.includes("--check")) {
    const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
    if (existing !== generated) {
      throw new Error("OpenAPI artifact is stale. Run `npm run openapi:generate` from the repository root.");
    }
    process.stdout.write("OpenAPI artifact matches the Zod schemas and route registry\n");
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated);
  process.stdout.write(`Generated ${path.relative(process.cwd(), outputPath)}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
