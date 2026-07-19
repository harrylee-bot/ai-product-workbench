import { parseIfMatch, revisionEtag } from "../src/common/http-preconditions.js";

describe("HTTP revision preconditions", () => {
  it("round trips a resource revision", () => {
    expect(parseIfMatch(revisionEtag(7))).toBe(7);
  });

  it("rejects missing and malformed preconditions", () => {
    expect(() => parseIfMatch(undefined)).toThrow();
    expect(() => parseIfMatch("7")).toThrow();
    expect(() => parseIfMatch('W/"7"')).toThrow();
    expect(() => parseIfMatch('"7", "8"')).toThrow();
    expect(() => parseIfMatch('"007"')).toThrow();
    expect(() => parseIfMatch(' "7"')).toThrow();
    expect(() => parseIfMatch('"7" ')).toThrow();
    expect(() => parseIfMatch('"9007199254740992"')).toThrow();
  });
});
