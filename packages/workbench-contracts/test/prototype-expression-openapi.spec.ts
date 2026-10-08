import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  prototypeExpressionSchema,
  type PrototypeExpression,
  type PrototypeRuntimeValue,
} from "../src/prototype.js";

const contract = YAML.parse(readFileSync(new URL("../openapi/workbench.v1.yaml", import.meta.url), "utf8"));
const validator = new Validator({
  $ref: "#/components/schemas/PrototypeExpression",
  components: contract.components,
}, "2020-12");
const literal = (value: PrototypeRuntimeValue): PrototypeExpression => ({ kind: "literal", value });

function expectBothToAccept(value: unknown, accepted: boolean): void {
  expect(validator.validate(value).valid).toBe(accepted);
  expect(prototypeExpressionSchema.safeParse(value).success).toBe(accepted);
}

describe("Prototype expression generated OpenAPI parity", () => {
  it("preserves every operator and scalar literal type", () => {
    const examples: PrototypeExpression[] = [
      literal("Book"), literal(12), literal(true), literal(null),
      { kind: "variable", path: "filter.query" },
      { kind: "contains", left: literal("The Left Hand of Darkness"), right: literal("left hand") },
      { kind: "equals", left: literal(null), right: literal(1) },
      { kind: "and", operands: [literal(true)] },
      { kind: "or", operands: Array.from({ length: 16 }, () => literal(false)) },
      { kind: "not", operand: literal(true) },
    ];
    for (const expression of examples) expectBothToAccept(expression, true);
  });

  it("preserves the eight-level bound including nested binary and array operators", () => {
    let expression = literal(true);
    for (let depth = 2; depth <= 8; depth += 1) {
      expression = depth % 3 === 0
        ? { kind: "equals", left: expression, right: literal(true) }
        : depth % 3 === 1
          ? { kind: "and", operands: [expression] }
          : { kind: "not", operand: expression };
      expectBothToAccept(expression, true);
    }
    expectBothToAccept({ kind: "not", operand: expression }, false);
  });

  it("rejects unsupported operators, unknown fields, incomplete nodes, and operand overflow", () => {
    for (const expression of [
      { kind: "script", code: "alert(1)" },
      { kind: "literal", value: true, fallback: false },
      { kind: "variable", path: "filter.query", fallback: "" },
      { kind: "contains", left: literal("Book") },
      { kind: "equals", left: literal(1), right: literal(1), extra: true },
      { kind: "not" },
      { kind: "and", operands: [] },
      { kind: "or", operands: Array.from({ length: 17 }, () => literal(true)) },
      { kind: "and", operands: [{ kind: "variable", path: "filter.query", extra: true }] },
    ]) expectBothToAccept(expression, false);
  });

  it("preserves variable path and literal length restrictions at each depth", () => {
    for (const path of ["query", "filter.query", "Form2.query_1", "a".repeat(500)]) {
      expectBothToAccept({ kind: "variable", path }, true);
    }
    for (const path of ["", "0query", "filter..query", "filter.query.", "filter[0]", "a".repeat(501)]) {
      expectBothToAccept({ kind: "variable", path }, false);
      expectBothToAccept({ kind: "not", operand: { kind: "variable", path } }, false);
    }
    expectBothToAccept(literal("a".repeat(10_000)), true);
    expectBothToAccept(literal("a".repeat(10_001)), false);
  });
});
