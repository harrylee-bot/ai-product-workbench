import { describe, expect, it } from "vitest";

import { BoundedLruLedger } from "./lru-ledger";

describe("BoundedLruLedger", () => {
  it("evicts the least recently read entry", () => {
    const ledger = new BoundedLruLedger<number>(2);
    ledger.set("first", 1);
    ledger.set("second", 2);

    expect(ledger.get("first")).toBe(1);
    ledger.set("third", 3);

    expect(ledger.has("first")).toBe(true);
    expect(ledger.has("second")).toBe(false);
    expect(ledger.get("third")).toBe(3);
  });

  it("replaces entries without growing and can be cleared", () => {
    const ledger = new BoundedLruLedger<number>(2);
    ledger.set("call", 1);
    ledger.set("call", 2);

    expect(ledger.size).toBe(1);
    expect(ledger.get("call")).toBe(2);
    ledger.clear();
    expect(ledger.size).toBe(0);
  });

  it("rejects invalid capacities", () => {
    expect(() => new BoundedLruLedger(0)).toThrow(RangeError);
    expect(() => new BoundedLruLedger(1.5)).toThrow(RangeError);
  });
});
