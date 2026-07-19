import { decodeCursor, encodeCursor } from "../src/modules/projects/projects.service.js";

describe("project cursor", () => {
  it("round trips the stable sort tuple", () => {
    const cursor = {
      updatedAt: "2026-07-12T00:00:00.000Z",
      id: "project_1",
      q: "dashboard",
      relationship: "shared" as const,
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects invalid cursors", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow();
  });
});
