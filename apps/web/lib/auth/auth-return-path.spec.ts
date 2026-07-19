import { describe, expect, it } from "vitest";

import {
  authRouteWithReturnPath,
  safeAuthReturnPath,
} from "./auth-return-path";

describe("authentication return paths", () => {
  it("preserves an internal path, query, and hash", () => {
    expect(safeAuthReturnPath("/projects/project_1?tab=files#latest"))
      .toBe("/projects/project_1?tab=files#latest");
    expect(authRouteWithReturnPath("/register", "/projects/project_1?tab=files"))
      .toBe("/register?next=%2Fprojects%2Fproject_1%3Ftab%3Dfiles");
  });

  it.each([
    null,
    "",
    "https://attacker.example/path",
    "//attacker.example/path",
    "///attacker.example/path",
    "/\\attacker.example/path",
    "/projects/project_1\u0000",
  ])("rejects an unsafe return path: %s", (value) => {
    expect(safeAuthReturnPath(value)).toBe("/");
  });

  it("does not add a redundant next parameter for the home page", () => {
    expect(authRouteWithReturnPath("/login", "/")).toBe("/login");
  });
});
