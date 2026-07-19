import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createIdempotencyKey,
  immutableVersioned,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
} from "./contracts";

const defaultedSchema = z.object({
  values: z.array(z.string()).default([]),
}).strict();

describe("Workbench transport contract output typing", () => {
  it("returns the parsed Zod output when input defaults are optional", () => {
    const parsed = parseContract(defaultedSchema, {}, "parse defaults");
    const mutable = versioned(
      defaultedSchema,
      {},
      responseWithEtag('"1"'),
      "version defaults",
    );
    const immutable = immutableVersioned(
      defaultedSchema,
      {},
      responseWithEtag('"digest"'),
      "immutable defaults",
    );

    expectTypeOf(parsed).toEqualTypeOf<{ values: string[] }>();
    expectTypeOf(mutable.value).toEqualTypeOf<{ values: string[] }>();
    expectTypeOf(immutable.value).toEqualTypeOf<{ values: string[] }>();
    expect(parsed).toEqual({ values: [] });
    expect(mutable).toEqual({ value: { values: [] }, etag: '"1"' });
    expect(immutable).toEqual({ value: { values: [] }, etag: '"digest"' });
  });

  it("creates URL-safe idempotency keys and rejects invalid caller values", () => {
    expect(createIdempotencyKey("approval")).toMatch(/^approval:[A-Za-z0-9_-]{24}$/);
    expect(() => normalizeIdempotencyKey("short")).toThrow(/8-128/);
    expect(normalizeIdempotencyKey(" run:request_123 ")).toBe("run:request_123");
  });
});

function responseWithEtag(etag: string): Response {
  return new Response(null, { headers: { ETag: etag } });
}
