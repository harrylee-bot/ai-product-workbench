import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Workbench route ownership", () => {
  it("mounts the new Onlook Studio at explicit route boundaries", async () => {
    const appEntries = await readdir(path.join(webRoot, "app"));
    const homePageSource = await readFile(path.join(webRoot, "app/(workbench)/page.tsx"), "utf8");
    const projectPageSource = await readFile(
      path.join(webRoot, "app/(workbench)/studio/[projectId]/page.tsx"),
      "utf8",
    );
    const layoutSource = await readFile(path.join(webRoot, "app/(workbench)/layout.tsx"), "utf8");

    expect(appEntries).toContain("(workbench)");
    expect(appEntries).not.toContain("(chat)");
    expect(homePageSource).toContain("StudioHome");
    expect(projectPageSource).toContain("StudioProject");
    expect(layoutSource).not.toContain("WorkbenchRuntimeProvider");
    expect(existsSync(path.join(webRoot,"app/(workbench)/projects/[projectId]/page.tsx"))).toBe(false);

  });

  it("keeps Project UI and editor runtimes out of the Home static module graph", () => {
    const homeGraph = collectStaticModuleGraph([
      path.join(webRoot, "app/(workbench)/layout.tsx"),
      path.join(webRoot, "app/(workbench)/page.tsx"),
    ]);
    const projectOnlyFiles = [
      "workbench-artifact-version-dialog.tsx",
      "workbench-board-conflict-dialog.tsx",
      "workbench-board-nodes.tsx",
      "workbench-canvas-tools.tsx",
      "workbench-export-dialog.tsx",
      "workbench-prd-editor.tsx",
      "workbench-project-chrome.tsx",
      "workbench-project-composer.tsx",
      "workbench-project-members-dialog.tsx",
      "workbench-project-route.tsx",
      "workbench-project-screen-controller.ts",
      "workbench-project-screen-view.tsx",
      "workbench-run-approval-dialog.tsx",
      "workbench-share-dialog.tsx",
    ];

    for (const fileName of projectOnlyFiles) {
      expect([...homeGraph.files], fileName).not.toContainEqual(
        expect.stringMatching(new RegExp(`${escapeRegExp(fileName)}$`)),
      );
    }
    expect([...homeGraph.packages]).not.toContain("@xyflow/react");
    expect([...homeGraph.packages]).not.toContain("react-moveable");
    expect([...homeGraph.packages]).not.toContain("react-selecto");
    expect([...homeGraph.packages].some((name) => name.startsWith("@tiptap/"))).toBe(false);
  });

  it("keeps the retired workbench and React Flow outside all new app entry graphs", () => {
    const graph=collectStaticModuleGraph([
      path.join(webRoot,"app/(workbench)/studio/[projectId]/page.tsx"),
      path.join(webRoot,"app/prototype-share/[token]/page.tsx"),
      path.join(webRoot,"app/share/[token]/page.tsx"),
    ]);
    expect([...graph.files].filter(file=>file.includes("/components/workbench/"))).toEqual([]);
    expect([...graph.packages]).not.toContain("@xyflow/react");
    expect([...graph.files].some(file=>file.endsWith("/studio/onlook/canvas.tsx"))).toBe(true);
  });

  it("does not publish or protect a legacy conversation URL", async () => {
    const proxySource = await readFile(path.join(webRoot, "proxy.ts"), "utf8");

    expect(proxySource).not.toContain('"/chat"');
    expect(proxySource).not.toContain('"/chat/:path*"');
  });
});

function collectStaticModuleGraph(entryFiles: string[]) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [...entryFiles];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
    for (const specifier of staticModuleSpecifiers(ast)) {
      const dependency = resolveWorkbenchModule(file, specifier);
      if (dependency) pending.push(dependency);
      else if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        packages.add(packageName(specifier));
      }
    }
  }

  return { files, packages };
}

function staticModuleSpecifiers(ast: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && !statement.importClause?.isTypeOnly
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier)
      && !statement.isTypeOnly
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return specifiers;
}

function resolveWorkbenchModule(importer: string, specifier: string): string | null {
  const unresolved = specifier.startsWith("@/")
    ? path.join(webRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(importer), specifier)
      : null;
  if (!unresolved) return null;
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}.js`,
    `${unresolved}.jsx`,
    path.join(unresolved, "index.ts"),
    path.join(unresolved, "index.tsx"),
  ];
  return candidates.find((candidate) => (
    existsSync(candidate)
    && statSync(candidate).isFile()
    && !candidate.endsWith(".css")
  )) ?? null;
}

function packageName(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0]!;
  return specifier.split("/").slice(0, 2).join("/");
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
