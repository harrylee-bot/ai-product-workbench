import { describe, expect, it } from "vitest";
import {
  formatLegacySchemaViolations,
  hasLegacySchemaViolations,
} from "../../../scripts/assert-no-legacy-schema.mjs";

describe("legacy schema deployment guard", () => {
  it("reports legacy project/product/product-design residue clearly", () => {
    const violations = {
      tables: [{ table_name: "product_design_states" }],
      columns: [{ table_name: "share_links", column_name: "product_design_state_id" }],
      types: [{ typname: "ProjectStatus" }],
    };

    expect(hasLegacySchemaViolations(violations)).toBe(true);
    expect(formatLegacySchemaViolations(violations)).toContain("product_design_states");
    expect(formatLegacySchemaViolations(violations)).toContain("share_links.product_design_state_id");
    expect(formatLegacySchemaViolations(violations)).toContain("ProjectStatus");
  });

  it("accepts a clean conversation-first schema snapshot", () => {
    expect(hasLegacySchemaViolations({ tables: [], columns: [], types: [] })).toBe(false);
  });
});
