import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Workbench route ownership", () => {
  it("keeps Next pages as URL boundaries and gives the persistent Scene one visual owner", async () => {
    const appEntries = await readdir(path.join(webRoot, "app"));
    const homePageSource = await readFile(path.join(webRoot, "app/(workbench)/page.tsx"), "utf8");
    const projectPageSource = await readFile(
      path.join(webRoot, "app/(workbench)/projects/[projectId]/page.tsx"),
      "utf8",
    );
    const layoutSource = await readFile(path.join(webRoot, "app/(workbench)/layout.tsx"), "utf8");

    expect(appEntries).toContain("(workbench)");
    expect(appEntries).not.toContain("(chat)");
    expect(homePageSource).toContain("return null");
    expect(homePageSource).not.toContain("WorkbenchHomeRoute");
    expect(projectPageSource).toContain("return null");
    expect(projectPageSource).not.toContain("WorkbenchProjectRoute");
    expect(layoutSource).toContain("<WorkbenchRuntimeProvider />");
    expect(layoutSource).not.toContain("project.css");
    expect(layoutSource).not.toContain("WorkbenchProjectRoute");
    expect(layoutSource).not.toContain("WorkbenchHomeRoute");
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

  it("uses one awaitable dynamic edge to the Project route and scopes its CSS to that page", async () => {
    const runtimeSource = await readFile(
      path.join(webRoot, "components/workbench/workbench-runtime.tsx"),
      "utf8",
    );
    const homeRouteSource = await readFile(
      path.join(webRoot, "components/workbench/workbench-home-route.tsx"),
      "utf8",
    );
    const projectRouteSource = await readFile(
      path.join(webRoot, "components/workbench/workbench-project-route.tsx"),
      "utf8",
    );
    const sceneSource = await readFile(
      path.join(webRoot, "components/workbench/workbench-scene.tsx"),
      "utf8",
    );
    const loaderSource = await readFile(
      path.join(webRoot, "components/workbench/workbench-project-route-loader.ts"),
      "utf8",
    );
    const globalCss = await readFile(path.join(webRoot, "app/globals.css"), "utf8");
    const projectCss = await readFile(
      path.join(webRoot, "components/workbench/workbench-project.css"),
      "utf8",
    );
    const prdEditorSource = await readFile(
      path.join(webRoot, "components/workbench/workbench-prd-editor.tsx"),
      "utf8",
    );

    expect(runtimeSource).toContain("prepareProjectRoute: preloadWorkbenchProjectRoute");
    expect(runtimeSource).toContain("item.href === currentHref");
    expect(runtimeSource).toContain("workbenchRouteIsCommitted(nextHref)");
    expect(runtimeSource).toContain("workbenchRouteIsCommitted(pending.href)");
    expect(runtimeSource).not.toContain("destination.pathname === pathnameRef.current");
    expect(runtimeSource).not.toContain('from "./workbench-project-route"');
    expect(runtimeSource).toContain("onExitComplete={finalizeSceneExit}");
    expect(sceneSource).not.toContain("lazy(");
    expect(sceneSource).toContain("readWorkbenchProjectRoute()");
    expect(sceneSource).toContain("throw preloadWorkbenchProjectRoute()");
    expect(sceneSource).toContain("return <ProjectRoute />");
    expect(sceneSource).toContain("<WorkbenchRouteTransition");
    expect(sceneSource).toContain(
      "onExitComplete={() => onExitComplete(contextValue.workbench.selectedProjectId)}",
    );
    expect(sceneSource).toContain("routeView={routeView}");
    expect(homeRouteSource).not.toContain("WorkbenchRouteTransition");
    expect(projectRouteSource).not.toContain("WorkbenchRouteTransition");
    expect(projectRouteSource).toContain('import "./workbench-project.css"');
    expect(loaderSource.match(/\?\?= import\("\.\/workbench-project-route"\)/g)).toHaveLength(1);
    expect(loaderSource).toContain("await loadRoute()");
    expect(globalCss).not.toContain('@import "@xyflow/react/dist/style.css"');
    expect(globalCss).not.toContain(".react-flow__");
    expect(globalCss).not.toContain("--xy-");
    expect(projectCss).toContain('@import "@xyflow/react/dist/style.css"');
    expect(projectCss).toContain(".ProseMirror");
    expect(projectCss).toContain(".workbench-prd-editor-content .tiptap");
    expect(prdEditorSource).toContain('className="workbench-prd-editor-content"');
    expect(prdEditorSource).not.toContain("[&_.tiptap");
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
