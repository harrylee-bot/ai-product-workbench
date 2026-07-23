import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runtimeResultSchema } from "../src/runtime.js";

const prototypeExamplePath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json",
  import.meta.url,
));
const prototypeExampleSource = readFileSync(prototypeExamplePath, "utf8");
const prdExamplePath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/prd-runtime-result.example.json",
  import.meta.url,
));
const prdExampleSource = readFileSync(prdExamplePath, "utf8");

describe("DeerFlow PRD Runtime Result reference", () => {
  it("stays compact and valid against the production Runtime result schema", () => {
    const example = JSON.parse(prdExampleSource) as unknown;
    const result = runtimeResultSchema.parse(example);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "prd",
      schemaVersion: 1,
      operation: { kind: "create" },
    });
    expect(Buffer.byteLength(prdExampleSource, "utf8")).toBeLessThan(16_000);
    expect(prdExampleSource.split("\n").length).toBeLessThan(400);
  });
});

describe("DeerFlow Prototype Runtime Result reference", () => {
  it("stays compact and valid against the production Runtime result schema", () => {
    const example = JSON.parse(prototypeExampleSource) as unknown;
    const result = runtimeResultSchema.parse(example);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "prototype",
      schemaVersion: 1,
      operation: { kind: "create" },
    });
    if (result.artifacts[0]?.kind !== "prototype") throw new Error("Expected Prototype reference");
    expect(result.artifacts[0].content.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: { kind: "variable", path: "form.name" } }),
      expect.objectContaining({
        source: { kind: "state", stateId: "state-ready", field: "submitLabel" },
      }),
    ]));
    expect(Buffer.byteLength(prototypeExampleSource, "utf8")).toBeLessThan(16_000);
    expect(prototypeExampleSource.split("\n").length).toBeLessThan(400);
  });

  it("accepts canonical date inputs through the complete Runtime result envelope", () => {
    const example = JSON.parse(prototypeExampleSource) as {
      artifacts: Array<{
        content: {
          nodes: Array<{ id: string; inputType?: string }>;
          variables: Array<{ path: string; initialValue: unknown }>;
        };
      }>;
    };
    const content = example.artifacts[0]!.content;
    const input = content.nodes.find((node) => node.id === "node-name");
    const variable = content.variables.find((candidate) => candidate.path === "form.name");
    if (!input || !variable) throw new Error("Prototype Runtime Result date fixture is incomplete");
    input.inputType = "date";
    variable.initialValue = "2026-07-16";

    expect(runtimeResultSchema.safeParse(example).success).toBe(true);
    variable.initialValue = "2026-02-29";
    expect(runtimeResultSchema.safeParse(example).success).toBe(false);
  });
});
