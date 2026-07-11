import { describe, expect, it } from "vitest";
import {
  findEnumLabelViolations,
  findForeignKeyViolations,
  findRequiredColumnViolations,
  formatLegacySchemaViolations,
  hasLegacySchemaViolations,
} from "../../../scripts/assert-no-legacy-schema.mjs";

describe("legacy schema deployment guard", () => {
  it("reports legacy project/product/product-design residue clearly", () => {
    const violations = {
      tables: [{ table_name: "product_design_states" }],
      columns: [
        { table_name: "share_links", column_name: "product_design_state_id" },
      ],
      types: [{ typname: "ProjectStatus" }],
    };

    expect(hasLegacySchemaViolations(violations)).toBe(true);
    expect(formatLegacySchemaViolations(violations)).toContain(
      "product_design_states",
    );
    expect(formatLegacySchemaViolations(violations)).toContain(
      "share_links.product_design_state_id",
    );
    expect(formatLegacySchemaViolations(violations)).toContain("ProjectStatus");
  });

  it("accepts a clean conversation-first schema snapshot", () => {
    expect(
      hasLegacySchemaViolations({ tables: [], columns: [], types: [] }),
    ).toBe(false);
  });

  it("detects retired and missing enum labels", () => {
    const violations = findEnumLabelViolations(
      [{ enum_name: "KnowledgeScope", labels: ["global", "conversation"] }],
      [
        { enum_name: "KnowledgeScope", enum_label: "global" },
        { enum_name: "KnowledgeScope", enum_label: "project" },
        { enum_name: "KnowledgeScope", enum_label: "product" },
      ],
    );

    expect(violations).toEqual([
      {
        enum_name: "KnowledgeScope",
        expected_labels: ["conversation", "global"],
        actual_labels: ["global", "product", "project"],
      },
    ]);
    expect(
      hasLegacySchemaViolations({
        tables: [],
        columns: [],
        types: [],
        enumLabels: violations,
      }),
    ).toBe(true);
  });

  it("detects nullable, missing, and incorrectly constrained conversation columns", () => {
    const nullableColumns = findRequiredColumnViolations(
      [
        ["file_assets", "conversation_id"],
        ["knowledge_candidates", "conversation_id"],
      ],
      [
        {
          table_name: "file_assets",
          column_name: "conversation_id",
          is_nullable: "YES",
        },
      ],
    );
    const foreignKeys = findForeignKeyViolations(
      [
        [
          "file_assets",
          "conversation_id",
          "conversations",
          "id",
          "CASCADE",
          "CASCADE",
        ],
      ],
      [
        {
          table_name: "file_assets",
          column_name: "conversation_id",
          foreign_table_name: "conversations",
          foreign_column_name: "id",
          delete_rule: "SET NULL",
          update_rule: "CASCADE",
        },
      ],
    );

    expect(nullableColumns).toEqual([
      {
        table_name: "file_assets",
        column_name: "conversation_id",
        actual_nullable: "YES",
      },
      {
        table_name: "knowledge_candidates",
        column_name: "conversation_id",
        actual_nullable: "MISSING",
      },
    ]);
    expect(foreignKeys).toHaveLength(1);

    const formatted = formatLegacySchemaViolations({
      tables: [],
      columns: [],
      types: [],
      nullableColumns,
      foreignKeys,
    });
    expect(formatted).toContain("file_assets.conversation_id (YES)");
    expect(formatted).toContain("ON DELETE CASCADE");
  });
});
