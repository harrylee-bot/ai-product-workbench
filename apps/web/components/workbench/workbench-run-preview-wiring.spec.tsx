import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const projectRouteFile = fileURLToPath(new URL("./workbench-project-route.tsx", import.meta.url));
const viewFile = fileURLToPath(new URL("./workbench-project-screen-view.tsx", import.meta.url));
const runControllerFile = fileURLToPath(new URL(
  "../../lib/workbench/features/run-controller.ts",
  import.meta.url,
));

describe("Workbench Run preview wiring", () => {
  it("provides live ProjectScreen Run data around ReactFlow", async () => {
    const ast = await sourceAst(viewFile);
    const provider = findJsxElement(ast, "WorkbenchRunPreviewProvider");

    expect(provider).toBeDefined();
    expect(jsxAttributeNames(provider!.openingElement.attributes)).toEqual([
      "phase",
      "projectTitle",
      "prompt",
      "runActivities",
      "runMessages",
      "runPhaseLabel",
      "runStatus",
    ]);
    expect(findJsxElement(provider!, "ReactFlow")).toBeDefined();
  });

  it("provides the Run-scoped Prototype projection around real Board nodes", async () => {
    const ast = await sourceAst(viewFile);
    const provider = findJsxElement(ast, "PrototypePatchProjectionProvider");

    expect(provider).toBeDefined();
    expect(jsxAttributeNames(provider!.openingElement.attributes)).toEqual(["projector"]);
    expect(findJsxElement(provider!, "ReactFlow")).toBeDefined();

    const source = await readFile(projectRouteFile, "utf8");
    expect(source).toContain(
      "prototypePatchProjector: workbench.runController.prototypePatchProjector",
    );
    expect(source).toContain("prototypePatchProjector,");
  });

  it("keeps patch-only events out of the ReactFlow root state path", async () => {
    const source = await readFile(runControllerFile, "utf8");

    expect(source).not.toContain("useSyncExternalStore");
    expect(source).toContain("const projectionOnlyEvent = isPrototypePatchProjectionEvent(event)");
    expect(source).toContain("&& !projectionOnlyEvent");
    expect(source).toContain("if (!projectionOnlyEvent) updateRunCache");
    expect(source).toContain("prototypePatchProjector,");
  });

  it("passes the live Run projection status and phase label into the preview", async () => {
    const source = await readFile(projectRouteFile, "utf8");

    expect(source).toContain("runPhaseLabel: workbench.runPhaseLabel");
    expect(source).toContain("runStatus: workbench.runStatus");
    expect(source).not.toContain("runPhaseLabel={workbench.currentRun?.phaseLabel ?? null}");
    expect(source).not.toContain("runStatus={workbench.currentRun?.status ?? null}");
  });

  it("opens only the captured ready Prototype reference from the Preview button or node double click", async () => {
    const [routeSource, viewSource] = await Promise.all([
      readFile(projectRouteFile, "utf8"),
      readFile(viewFile, "utf8"),
    ]);

    expect(viewSource).toContain("onNodeDoubleClick={canvas.onNodeDoubleClick}");
    expect(routeSource).toContain("openPreview(screenContextState.previewDisposition.reference)");
    expect(routeSource).toContain("onNodeDoubleClick: (_event, node) =>");
    expect(routeSource).toContain("projectReadyPrototypePreviewArtifacts(");
  });

  it("previews runnable multi-screen selections and captures static targets without auto-submitting", async () => {
    const source = await readFile(projectRouteFile, "utf8");

    expect(source).toContain(
      "artifactTargets: structuredClone(artifactSelection.selectedPrototypeRunTargets)",
    );
    expect(source).toContain("previewSelectedScreens");
    expect(source).toContain("openPreview(screenContextState.previewDisposition.references)");
    expect(source).toContain("`为“${screenContextState.target.title}”生成可交互原型`");
    expect(source).toContain("`为所选 ${count} 个界面生成可交互原型`");
    expect(source).not.toContain("void submitPromptWithCanvasSnapshot({\n      prompt: `为所选");
  });

  it("uses Run terminal status for Draft lifecycle without coupling message streams to node replacement", async () => {
    const ast = await projectRouteAst();
    const effects = findCalls(ast, "useEffect").filter((call) => (
      call.arguments[0]?.getText(ast).includes("projectRunBoardNodes")
    ));

    expect(effects).toHaveLength(1);
    const dependencies = effects[0]?.arguments[1];
    expect(Boolean(dependencies && ts.isArrayLiteralExpression(dependencies))).toBe(true);
    const dependencyNames = dependencies && ts.isArrayLiteralExpression(dependencies)
      ? dependencies.elements.map((element) => element.getText(ast))
      : [];
    expect(dependencyNames).not.toContain("runActivities");
    expect(dependencyNames).not.toContain("runMessages");
    expect(dependencyNames).not.toContain("runPhaseLabel");
    expect(dependencyNames).toContain("runStatus");
  });

  it("contains no legacy synthetic Run copy in the production component", async () => {
    const source = await Promise.all([
      readFile(projectRouteFile, "utf8"),
      readFile(viewFile, "utf8"),
    ]).then((files) => files.join("\n"));

    for (const fakeCopy of syntheticRunCopy) {
      expect(source, fakeCopy).not.toContain(fakeCopy);
    }
  });
});

const syntheticRunCopy = [
  "产品工作台示例项目",
  "Assistant Active",
  "Initialize grid syst...",
  "Generate color tokens",
  "Synthesizing layout...",
  "Apply shader effects",
  "14:42:11",
  "14:42:15",
  "view_quilt Debug_Frame_v2: Frame",
  "Make it darker",
  "Add a hero",
  "Bento layout",
  "Debug Canvas",
  "Shader",
  "tile-synthetic-workbench",
  "image placeholder",
  "image palette",
  "调试页面 - 文档",
  "调试页面 - 对话",
  "image dark",
  "image light",
  "Lumina Dark",
  "调试页面 - Ge...",
  "产品工作台界面代码...",
  "产品工作台交互实现...",
  "产品工作台样式系统",
  'title: "产品工作台..."',
] as const;

async function projectRouteAst() {
  return sourceAst(projectRouteFile);
}

async function sourceAst(file: string) {
  const source = await readFile(file, "utf8");
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function findJsxElement(root: ts.Node, name: string): ts.JsxElement | undefined {
  let match: ts.JsxElement | undefined;
  const visit = (node: ts.Node) => {
    if (
      !match
      && ts.isJsxElement(node)
      && ts.isIdentifier(node.openingElement.tagName)
      && node.openingElement.tagName.text === name
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return match;
}

function jsxAttributeNames(attributes: ts.JsxAttributes): string[] {
  return attributes.properties.flatMap((property) => (
    ts.isJsxAttribute(property) && ts.isIdentifier(property.name)
      ? [property.name.text]
      : []
  ));
}

function findCalls(root: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}
