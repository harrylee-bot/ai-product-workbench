import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import YAML from "yaml";
import { prototypeDocumentSchema, publicPrototypeDocumentSchema, type PrototypeNode } from "../src/prototype.js";
import { prototypeDocumentFixture } from "./prototype-fixture.js";

const typography = (): NonNullable<PrototypeNode["style"]["typography"]> => ({
  fontFamily: { kind: "literal", value: "sans-serif" },
  fontSize: { kind: "literal", value: 16 }, fontWeight: { kind: "literal", value: 400 },
  lineHeight: { kind: "literal", value: 24 }, letterSpacing: { kind: "literal", value: 0 },
  align: "left", transform: "none", decoration: "none",
});

describe("Prototype typography color", () => {
  it("keeps generated OpenAPI optional colors aligned with the runtime contract", () => {
    const contract = YAML.parse(readFileSync(new URL("../openapi/workbench.v1.yaml", import.meta.url), "utf8"));
    const validator = new Validator({ $ref: "#/components/schemas/PrototypeTypography", components: contract.components }, "2020-12");
    for (const value of [typography(), { ...typography(), color: { kind: "literal", value: "#12345680" } }, { ...typography(), color: { kind: "token", tokenId: "foreground" } }]) expect(validator.validate(value).valid).toBe(true);
    expect(validator.validate({ ...typography(), color: { kind: "literal", value: "red" } }).valid).toBe(false);
  });
  it("preserves legacy IR without introducing a default or changing its checksum input", () => {
    const document = prototypeDocumentFixture();
    document.nodes[1]!.style.typography = typography();
    expect(prototypeDocumentSchema.parse(document)).toEqual(document);
  });

  it.each(["#ffffff", "#11223380"]) ("accepts an explicit literal %s in private and public IR", value => {
    const document = prototypeDocumentFixture();
    document.nodes[1]!.style.typography = { ...typography(), color: { kind: "literal", value } };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);
    expect(publicPrototypeDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("validates color token types on nodes and state overrides", () => {
    const document = prototypeDocumentFixture();
    document.tokens = [{ id: "foreground", name: "Foreground", type: "color", value: "#ffffff" }];
    document.nodes[1]!.style.typography = { ...typography(), color: { kind: "token", tokenId: "foreground" } };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);
    document.states = [{ id: "state-a", screenId: "screen-a", name: "A", values: {}, overrides: [{ nodeId: document.nodes[1]!.id, style: structuredClone(document.nodes[1]!.style) }] }];
    document.nodes[1]!.style.typography = typography();
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(true);
    document.tokens = [{ id: "foreground", name: "Wrong type", type: "number", value: 10 }];
    const result = prototypeDocumentSchema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["states", 0, "overrides", 0, "style"] }));
    document.nodes[1]!.style.typography = { ...typography(), color: { kind: "token", tokenId: "missing" } };
    expect(publicPrototypeDocumentSchema.safeParse(document).success).toBe(false);
  });

  it.each(["white", "#fff", "var(--color)", "#ffffff;background:url(https://invalid.test)"])("rejects color outside the existing hex contract: %s", value => {
    const document = prototypeDocumentFixture();
    document.nodes[1]!.style.typography = { ...typography(), color: { kind: "literal", value } };
    expect(prototypeDocumentSchema.safeParse(document).success).toBe(false);
  });
});
