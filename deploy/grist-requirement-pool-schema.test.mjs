import assert from "node:assert/strict";
import test from "node:test";

import {
  requirementPoolDocumentName,
  requirementPoolLegacyDocumentNames,
  requirementPoolTable,
  requirementPoolViewName,
  requirementPoolWorkspaceName,
} from "./grist-requirement-pool-schema.mjs";

test("requirement pool schema has stable unique identifiers", () => {
  assert.equal(requirementPoolTable.id, "Requirements");
  const identifiers = requirementPoolTable.columns.map((column) => column.id);
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.match(requirementPoolTable.columns[0].fields.formula, /REQ-/u);
});

test("requirement pool uses Chinese display names and keeps legacy discovery", () => {
  assert.equal(requirementPoolWorkspaceName, "需求管理");
  assert.equal(requirementPoolDocumentName, "需求池");
  assert.equal(requirementPoolViewName, "需求列表");
  assert.ok(requirementPoolLegacyDocumentNames.includes("需求池 / Requirement Pool"));
});

test("choice columns contain parseable options", () => {
  const choices = requirementPoolTable.columns.filter(
    (column) => column.fields.type === "Choice" || column.fields.type === "ChoiceList",
  );
  assert.ok(choices.length >= 4);
  for (const column of choices) {
    const options = JSON.parse(column.fields.widgetOptions);
    assert.ok(Array.isArray(options.choices));
  }
});
