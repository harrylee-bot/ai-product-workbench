import { describe, expect, it } from "vitest";
import { hasAmbientCredentials } from "../src/request-security.js";

describe("Preview request security", () => {
  it("rejects ambient browser and proxy credentials", () => {
    expect(hasAmbientCredentials({})).toBe(false);
    expect(hasAmbientCredentials({ cookie: "workbench_session=secret" })).toBe(true);
    expect(hasAmbientCredentials({ authorization: "Bearer secret" })).toBe(true);
    expect(hasAmbientCredentials({ "proxy-authorization": "Basic secret" })).toBe(true);
  });
});
