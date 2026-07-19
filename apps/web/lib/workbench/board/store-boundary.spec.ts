import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("Board React Flow runtime boundary", () => {
  it("keeps Board state on framework-neutral type imports", async () => {
    const storeImports = importsOf(fileURLToPath(new URL("./store.ts", import.meta.url)));
    const adapterImports = importsOf(fileURLToPath(new URL("./adapter.ts", import.meta.url)));

    await expect(storeImports).resolves.toEqual(expect.arrayContaining([{
      module: "@xyflow/system",
      typeOnly: true,
      values: [],
    }]));
    await expect(storeImports).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ module: "@xyflow/react" }),
    ]));
    await expect(adapterImports).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ module: "@xyflow/react" }),
    ]));
  });

  it("keeps the official reducers in the Project UI adapter", async () => {
    const adapterFile = fileURLToPath(new URL(
      "../../../components/workbench/workbench-project-react-flow-adapter.ts",
      import.meta.url,
    ));

    await expect(importsOf(adapterFile)).resolves.toEqual(expect.arrayContaining([{
      module: "@xyflow/react",
      typeOnly: false,
      values: ["applyEdgeChanges", "applyNodeChanges"],
    }]));
  });
});

async function importsOf(file: string) {
  const source = await readFile(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  return ast.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const clause = statement.importClause;
    const values = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements
        .filter((element) => !clause.isTypeOnly && !element.isTypeOnly)
        .map((element) => element.propertyName?.text ?? element.name.text)
        .sort()
      : [];
    return [{
      module: statement.moduleSpecifier.text,
      typeOnly: clause?.isTypeOnly ?? false,
      values,
    }];
  });
}
