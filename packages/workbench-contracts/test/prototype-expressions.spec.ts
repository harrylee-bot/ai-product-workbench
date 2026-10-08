import { describe, expect, it } from "vitest";
import {
  evaluatePrototypeExpression,
  prototypeDocumentSchema,
  prototypeExpressionSchema,
  prototypeExpressionVariablePaths,
  type PrototypeBinding,
  type PrototypeDocument,
  type PrototypeExpression,
  type PrototypeNode,
  type PrototypeRuntimeValue,
} from "../src/prototype.js";
import { projectPrototypeSourceScreens } from "../src/prototype-sources.js";
import { prototypeDocumentFixture } from "./prototype-fixture.js";

const literal = (value: PrototypeRuntimeValue): PrototypeExpression => ({ kind: "literal", value });
const variable = (path: string): PrototypeExpression => ({ kind: "variable", path });
const equals = (left: PrototypeExpression, right: PrototypeExpression): PrototypeExpression => ({ kind: "equals", left, right });

const books = [
  { title: "The Left Hand of Darkness", category: "fiction" },
  { title: "Clean Architecture", category: "software" },
  { title: "A Brief History of Time", category: "science" },
  { title: "人类简史", category: "history" },
];
const matchesBook = (book: typeof books[number]): PrototypeExpression => ({
  kind: "and",
  operands: [
    { kind: "contains", left: literal(book.title), right: variable("filter.query") },
    {
      kind: "or",
      operands: [
        equals(variable("filter.category"), literal("all")),
        equals(variable("filter.category"), literal(book.category)),
      ],
    },
  ],
});

function withExpression(
  expression: PrototypeExpression,
  property: PrototypeBinding["property"] = "visible",
): PrototypeDocument {
  const document = prototypeDocumentFixture();
  const node = document.nodes.find((candidate) => candidate.id === "node-a")!;
  node.bindingIds = ["binding-expression"];
  document.variables = [
    { path: "filter.query", initialValue: "" },
    { path: "filter.category", initialValue: "all" },
    { path: "filter.enabled", initialValue: true },
    { path: "unused.value", initialValue: "excluded" },
  ];
  document.bindings = [{
    id: "binding-expression",
    nodeId: node.id,
    property,
    source: { kind: "expression", expression },
  }];
  return document;
}

function asControl(document: PrototypeDocument, kind: "button" | "input" | "image"): void {
  const index = document.nodes.findIndex((node) => node.id === "node-a");
  const original = document.nodes[index]!;
  const { kind: _, ...base } = original;
  const common = Object.fromEntries(Object.entries(base).filter(([key]) => !["text", "maxLines"].includes(key)));
  document.nodes[index] = (kind === "button"
    ? { ...common, kind, label: "Action", childIds: [], buttonType: "button", disabled: false }
    : kind === "input"
      ? { ...common, kind, inputType: "search", fieldName: "query", label: "Query", placeholder: "", optionValue: null, options: [], required: false, disabled: false }
      : { ...common, kind, assetId: "image-book", alt: "Book", fit: "cover" }) as PrototypeNode;
}

function issues(document: unknown): string[] {
  const result = prototypeDocumentSchema.safeParse(document);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("Prototype bounded expressions", () => {
  it("filters arbitrary multi-word and Unicode queries together with category, shows empty results, and restores after clearing", () => {
    const predicates = books.map(matchesBook).map((expression) => prototypeExpressionSchema.parse(expression));
    const empty = prototypeExpressionSchema.parse({
      kind: "not",
      operand: { kind: "or", operands: predicates },
    });
    const values = new Map<string, PrototypeRuntimeValue>([["filter.query", ""], ["filter.category", "all"]]);
    const resolve = (path: string) => values.get(path);
    const visible = () => books.filter((_, index) => evaluatePrototypeExpression(predicates[index]!, resolve) === true).map((book) => book.title);

    expect(visible()).toEqual(books.map((book) => book.title));
    values.set("filter.query", "  LEFT HAND  ");
    expect(visible()).toEqual(["The Left Hand of Darkness"]);
    values.set("filter.category", "science");
    expect(visible()).toEqual([]);
    expect(evaluatePrototypeExpression(empty, resolve)).toBe(true);
    values.set("filter.query", "brief history");
    expect(visible()).toEqual(["A Brief History of Time"]);
    expect(evaluatePrototypeExpression(empty, resolve)).toBe(false);
    values.set("filter.query", "不存在的关键词");
    expect(visible()).toEqual([]);
    expect(evaluatePrototypeExpression(empty, resolve)).toBe(true);
    values.set("filter.category", "all");
    values.set("filter.query", "简史");
    expect(visible()).toEqual(["人类简史"]);
    values.set("filter.query", "");
    expect(visible()).toEqual(books.map((book) => book.title));
    expect(evaluatePrototypeExpression(empty, resolve)).toBe(false);
  });

  it("collects all sorted unique dependencies even when a branch does not currently match", () => {
    const expression: PrototypeExpression = {
      kind: "and",
      operands: [
        literal(false),
        matchesBook(books[0]!),
        equals(variable("filter.query"), variable("filter.query")),
      ],
    };
    expect(prototypeExpressionVariablePaths(expression)).toEqual(["filter.category", "filter.query"]);
    expect(() => evaluatePrototypeExpression(expression, () => undefined))
      .toThrow("PROTOTYPE_EXPRESSION_VARIABLE_UNRESOLVED");
  });

  it("preserves strict equality and refuses coercion or non-boolean logical operands", () => {
    const resolve = () => undefined;
    expect(evaluatePrototypeExpression(equals(literal(null), literal(null)), resolve)).toBe(true);
    expect(evaluatePrototypeExpression(equals(literal("Science"), literal("science")), resolve)).toBe(false);
    expect(evaluatePrototypeExpression(equals(literal(12), literal(12)), resolve)).toBe(true);
    expect(evaluatePrototypeExpression(equals(literal("12"), literal(12)), resolve)).toBe(false);
    expect(() => evaluatePrototypeExpression({ kind: "contains", left: literal(12), right: literal("1") }, resolve))
      .toThrow("PROTOTYPE_EXPRESSION_TYPE_INVALID");
    expect(() => evaluatePrototypeExpression({ kind: "and", operands: [literal(false), literal("true")] }, resolve))
      .toThrow("PROTOTYPE_EXPRESSION_TYPE_INVALID");
    expect(() => evaluatePrototypeExpression({ kind: "not", operand: literal(null) }, resolve))
      .toThrow("PROTOTYPE_EXPRESSION_TYPE_INVALID");
  });

  it("handles cleared number controls and long runtime text without throwing or coercing", () => {
    const values = new Map<string, PrototypeRuntimeValue>([["form.rating", 1], ["filter.query", ""]]);
    const resolve = (path: string) => values.get(path);
    const selected = equals(variable("form.rating"), literal(1));
    expect(evaluatePrototypeExpression(selected, resolve)).toBe(true);
    values.set("form.rating", null);
    expect(evaluatePrototypeExpression(selected, resolve)).toBe(false);
    values.set("form.rating", "1");
    expect(evaluatePrototypeExpression(selected, resolve)).toBe(false);
    values.set("filter.query", `${"a".repeat(10_001)}TITLE`);
    expect(evaluatePrototypeExpression({
      kind: "contains", left: variable("filter.query"), right: literal(" title "),
    }, resolve)).toBe(true);
    expect(prototypeExpressionSchema.safeParse(literal("a".repeat(10_001))).success).toBe(false);
  });

  it("accepts exactly depth eight and 64 nodes, rejecting overflow before recursive parsing or evaluation", () => {
    let depthEight = literal(true);
    for (let index = 1; index < 8; index += 1) depthEight = { kind: "not", operand: depthEight };
    const depthNine: PrototypeExpression = { kind: "not", operand: depthEight };
    const sixtyFour: PrototypeExpression = {
      kind: "and",
      operands: [
        ...Array.from({ length: 4 }, (): PrototypeExpression => ({
          kind: "and", operands: Array.from({ length: 14 }, () => literal(true)),
        })),
        literal(true), literal(true), literal(true),
      ],
    };
    const sixtyFive: PrototypeExpression = { ...sixtyFour, operands: [...sixtyFour.operands, literal(true)] };
    expect(prototypeExpressionSchema.safeParse(depthEight).success).toBe(true);
    expect(evaluatePrototypeExpression(depthEight, () => undefined)).toBe(false);
    expect(prototypeExpressionSchema.safeParse(sixtyFour).success).toBe(true);
    expect(evaluatePrototypeExpression(sixtyFour, () => undefined)).toBe(true);
    for (const expression of [depthNine, sixtyFive]) {
      expect(prototypeExpressionSchema.safeParse(expression).success).toBe(false);
      expect(() => evaluatePrototypeExpression(expression, () => undefined)).toThrow("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
      expect(() => prototypeExpressionVariablePaths(expression)).toThrow("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
    }
  });

  it("rejects cycles, oversized operand arrays, executable nodes, and undeclared schema fields", () => {
    const cycle = { kind: "not" } as PrototypeExpression & { operand: PrototypeExpression };
    cycle.operand = cycle;
    for (const expression of [
      cycle,
      { kind: "or", operands: [] },
      { kind: "and", operands: Array.from({ length: 17 }, () => literal(true)) },
      { kind: "script", code: "globalThis.fetch('/private')" },
      { kind: "variable", path: "filter.query", fallback: "unreviewed" },
      { kind: "literal", value: Infinity },
    ]) {
      expect(prototypeExpressionSchema.safeParse(expression).success).toBe(false);
    }
    expect(() => evaluatePrototypeExpression(cycle, () => undefined)).toThrow("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
  });

  it("embeds the shared evaluator and dependency walker without imported helpers", () => {
    const embeddedEvaluate = Function(`return (${evaluatePrototypeExpression.toString()});`)() as typeof evaluatePrototypeExpression;
    const embeddedPaths = Function(`return (${prototypeExpressionVariablePaths.toString()});`)() as typeof prototypeExpressionVariablePaths;
    const values = new Map<string, PrototypeRuntimeValue>([["filter.query", "ARCH"], ["filter.category", "software"]]);
    expect(embeddedEvaluate(matchesBook(books[1]!), (path) => values.get(path))).toBe(true);
    expect(embeddedPaths(matchesBook(books[1]!))).toEqual(["filter.category", "filter.query"]);
  });
});

describe("Prototype expression document semantics and projection", () => {
  it("accepts valid boolean and string projections and retains expression-only variables in a selected screen", () => {
    const document = withExpression(matchesBook(books[0]!));
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);
    const projection = projectPrototypeSourceScreens(document, ["screen-a"], "a".repeat(64));
    expect(projection.variables.map((item) => item.path)).toEqual(["filter.category", "filter.query"]);
    expect(projection.bindings).toEqual(document.bindings);
    expect(prototypeDocumentSchema.safeParse(withExpression(variable("filter.query"), "text")).success).toBe(true);
    const enabled = withExpression(variable("filter.enabled"), "enabled");
    asControl(enabled, "button");
    expect(prototypeDocumentSchema.safeParse(enabled).success).toBe(true);
  });

  it("reports unknown references and operand types instead of throwing out of safeParse", () => {
    expect(issues(withExpression(variable("filter.missing"))).join("\n")).toContain("unknown expression variable: filter.missing");
    expect(issues(withExpression({ kind: "contains", left: variable("filter.enabled"), right: literal("true") })).join("\n"))
      .toContain("contains requires strings");
    expect(prototypeDocumentSchema.safeParse(withExpression(equals(variable("filter.category"), literal(1)))).success).toBe(true);
    expect(issues(withExpression(literal(null))).join("\n")).toContain("visible expression must evaluate to boolean");
    expect(issues(withExpression(literal(true), "text")).join("\n")).toContain("text expression must evaluate to string");
  });

  it("keeps inputs writable and blocks computed image selection", () => {
    const valueDocument = withExpression(variable("filter.query"), "value");
    asControl(valueDocument, "input");
    expect(issues(valueDocument).join("\n")).toContain("every input requires exactly one variable-backed value binding");
    expect(issues(valueDocument).join("\n")).toContain("expression bindings may target only text, visible, or enabled");
    const imageDocument = withExpression(literal("image-book"), "imageAssetId");
    asControl(imageDocument, "image");
    imageDocument.assets = [{
      id: "image-book", kind: "image", name: "Book", blobId: "blob-book", mediaType: "image/png",
      byteSize: 16, sha256: "a".repeat(64), width: 32, height: 32,
    }];
    expect(issues(imageDocument).join("\n")).toContain("expression bindings may target only text, visible, or enabled");
  });

  it("keeps legacy literal and state bindings valid", () => {
    const document = withExpression(literal(true));
    document.bindings[0]!.source = { kind: "literal", value: true };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);
    document.states = [{ id: "state-filter", screenId: "screen-a", name: "Filter", values: { show: true }, overrides: [{ nodeId: "node-a", visible: true }] }];
    document.bindings[0]!.source = { kind: "state", stateId: "state-filter", field: "show" };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);
  });
});
