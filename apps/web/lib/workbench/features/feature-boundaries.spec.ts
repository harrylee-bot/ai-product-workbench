import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

type FeatureBoundaryConfig = {
  directoryEntryWorkbenchFeatures: readonly string[];
  layeredWorkbenchFeatures: readonly string[];
  workbenchFeatureLayers: readonly string[];
};

type DependencyCruiserConfig = {
  forbidden: readonly {
    from?: { path?: string };
    name: string;
    to?: { path?: string };
  }[];
};

type SourceModule = {
  dependencies: readonly string[];
  source: string;
};

const require = createRequire(import.meta.url);
const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const featuresRoot = path.join(webRoot, "lib/workbench/features");
const optionalFeatureLayers = ["ui"] as const;
const boundaryConfig = require(path.join(
  webRoot,
  "workbench-feature-boundaries.cjs",
)) as FeatureBoundaryConfig;
const dependencyCruiserConfig = require(path.join(
  webRoot,
  "../../.dependency-cruiser.cjs",
)) as DependencyCruiserConfig;

const sourceRoots = [
  path.join(webRoot, "app/(auth)"),
  path.join(webRoot, "app/(invitation)"),
  path.join(webRoot, "app/(workbench)"),
  path.join(webRoot, "app/share"),
  path.join(webRoot, "components/share"),
  path.join(webRoot, "components/workbench"),
  path.join(webRoot, "lib/workbench"),
];

describe("layered Workbench feature boundaries", () => {
  it("keeps each migrated feature behind one public entry", async () => {
    const graph = await sourceGraph();

    expect(boundaryConfig.layeredWorkbenchFeatures.length).toBeGreaterThan(0);
    expect(new Set(boundaryConfig.layeredWorkbenchFeatures).size).toBe(
      boundaryConfig.layeredWorkbenchFeatures.length,
    );
    expect(new Set(boundaryConfig.directoryEntryWorkbenchFeatures).size).toBe(
      boundaryConfig.directoryEntryWorkbenchFeatures.length,
    );
    expect(boundaryConfig.directoryEntryWorkbenchFeatures.every((feature) => (
      boundaryConfig.layeredWorkbenchFeatures.includes(feature)
    ))).toBe(true);

    for (const feature of boundaryConfig.layeredWorkbenchFeatures) {
      const facadeFile = path.join(featuresRoot, `${feature}.ts`);
      const featureRoot = path.join(featuresRoot, feature);
      const featureIndex = path.join(featureRoot, "index.ts");
      const usesDirectoryEntry = boundaryConfig.directoryEntryWorkbenchFeatures.includes(feature);
      const publicEntry = usesDirectoryEntry ? featureIndex : facadeFile;
      const expectedPublicEntries = [
        path.join(featureRoot, "application/index.ts"),
        path.join(featureRoot, "domain/index.ts"),
        ...optionalFeatureLayers
          .map((layer) => path.join(featureRoot, layer, "index.ts"))
          .filter((file) => graph.has(file)),
      ].sort();

      if (usesDirectoryEntry) {
        expect(graph.has(facadeFile), `${feature} must not have a same-name file facade`).toBe(false);
      } else {
        expect(graph.get(facadeFile)?.dependencies, `${feature} facade`).toEqual([
          featureIndex,
        ]);
      }
      expect(graph.get(featureIndex)?.dependencies.toSorted(), `${feature} public index`).toEqual(
        expectedPublicEntries,
      );

      const publicEntrySource = graph.get(publicEntry)?.source ?? "";
      const publicEntryAst = ts.createSourceFile(
        publicEntry,
        publicEntrySource,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(
        publicEntryAst.statements.every((statement) => (
          ts.isExportDeclaration(statement) || isDirective(statement)
        )),
        `${relative(publicEntry)} must remain a re-export-only public entry`,
      ).toBe(true);

      const implementationFiles = [...graph.keys()].filter((file) => (
        isInside(file, featureRoot) && file !== featureIndex
      ));
      for (const file of implementationFiles) {
        expect(
          [...boundaryConfig.workbenchFeatureLayers, ...optionalFeatureLayers].some((layer) => (
            isInside(file, path.join(featureRoot, layer))
          )),
          `${relative(file)} must live in a registered feature layer`,
        ).toBe(true);
      }

      for (const layer of boundaryConfig.workbenchFeatureLayers) {
        expect(
          graph.has(path.join(featureRoot, layer, "index.ts")),
          `${feature}/${layer} must expose an index.ts`,
        ).toBe(true);
      }
    }
  });

  it("rejects deep imports and inward layer dependencies", async () => {
    const graph = await sourceGraph();
    const violations: string[] = [];

    for (const feature of boundaryConfig.layeredWorkbenchFeatures) {
      const featureRoot = path.join(featuresRoot, feature);
      const publicEntry = boundaryConfig.directoryEntryWorkbenchFeatures.includes(feature)
        ? path.join(featureRoot, "index.ts")
        : path.join(featuresRoot, `${feature}.ts`);

      for (const [source, module] of graph) {
        for (const dependency of module.dependencies) {
          if (
            isInside(dependency, featureRoot)
            && source !== publicEntry
            && dependency !== publicEntry
            && !isInside(source, featureRoot)
          ) {
            violations.push(`${relative(source)} -> ${relative(dependency)}`);
          }

          const sourceLayer = featureLayer(source, featureRoot);
          const dependencyLayer = featureLayer(dependency, featureRoot);
          if (!sourceLayer || !dependencyLayer) continue;

          if (
            sourceLayer !== dependencyLayer
            && dependency !== path.join(featureRoot, dependencyLayer, "index.ts")
          ) {
            violations.push(`${relative(source)} deep-imports ${relative(dependency)}`);
          }

          if (
            sourceLayer === "domain"
            && (dependencyLayer === "application" || dependencyLayer === "api-adapter")
          ) {
            violations.push(`${relative(source)} domain dependency -> ${relative(dependency)}`);
          }

          if (sourceLayer === "api-adapter" && dependencyLayer === "application") {
            violations.push(`${relative(source)} adapter dependency -> ${relative(dependency)}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("has no aggregate Service or transport.service escape hatch", async () => {
    const graph = await sourceGraph();
    const aggregateService = path.join(featuresRoot, "service.ts");
    const boundarySpec = fileURLToPath(import.meta.url);
    const transportContext = path.join(webRoot, "lib/workbench/transport/context.tsx");

    expect(graph.has(aggregateService), "features/service.ts must stay deleted").toBe(false);
    expect(graph.get(transportContext)?.source).not.toMatch(/\bWorkbenchService\b|\bservice\s*:/);

    const staleServiceReferences = [...graph.entries()].flatMap(([file, module]) => {
      const referencesAggregate = module.dependencies.includes(aggregateService);
      const reachesTransportService = file !== boundarySpec
        && /\b(?:transport|context)\.service\b/.test(module.source);
      return referencesAggregate || reachesTransportService ? [relative(file)] : [];
    });
    expect(staleServiceReferences).toEqual([]);
  });

  it("wires the public-entry restriction into ESLint", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({
      cwd: webRoot,
      overrideConfig: {
        languageOptions: {
          parserOptions: {
            projectService: false,
          },
        },
      },
    });
    const filePath = path.join(
      featuresRoot,
      "index.ts",
    );
    const [publicEntryResult] = await eslint.lintText(
      'import { needsExportPolling } from "./exports";\nvoid needsExportPolling;\n',
      { filePath },
    );
    const [deepImportResult] = await eslint.lintText(
      'import { needsExportPolling } from "./exports/domain";\nvoid needsExportPolling;\n',
      { filePath },
    );

    expect(restrictedImportMessages(publicEntryResult.messages)).toEqual([]);
    expect(restrictedImportMessages(deepImportResult.messages)).toEqual([
      expect.stringContaining("top-level public entry"),
    ]);
  });

  it("prevents Workbench product code from importing database implementations", async () => {
    const databaseRule = dependencyCruiserConfig.forbidden.find(
      (rule) => rule.name === "workbench-does-not-import-database-layer",
    );

    expect(databaseRule?.from?.path).toContain("workbench");
    const databasePathPattern = new RegExp(databaseRule?.to?.path ?? "a^");
    expect([
      "../../packages/workbench-db/src/index.ts",
      "node_modules/@workbench/workbench-db/dist/index.js",
      "node_modules/@prisma/client/default.js",
      "node_modules/pg/lib/index.js",
    ].every((target) => databasePathPattern.test(target))).toBe(true);

    const { ESLint } = await import("eslint");
    const eslint = new ESLint({
      cwd: webRoot,
      overrideConfig: {
        languageOptions: {
          parserOptions: {
            projectService: false,
          },
        },
      },
    });
    const fixturePath = path.join(
      webRoot,
      "components/workbench/database-boundary-fixture.ts",
    );
    const restrictedSpecifiers = [
      "@workbench/workbench-db",
      "@prisma/client",
      "prisma",
      "pg",
      "pg-boss",
      "@/lib/db",
      "@/lib/db/queries",
    ];

    for (const specifier of restrictedSpecifiers) {
      const [result] = await eslint.lintText(
        `import database from ${JSON.stringify(specifier)};\nvoid database;\n`,
        { filePath: fixturePath },
      );
      expect(restrictedImportMessages(result.messages), specifier).toEqual([
        expect.stringContaining("database access belongs behind the Workbench API"),
      ]);

      const [dynamicResult] = await eslint.lintText(
        `void import(${JSON.stringify(specifier)});\n`,
        { filePath: fixturePath },
      );
      expect(restrictedSyntaxMessages(dynamicResult.messages), `dynamic ${specifier}`).toEqual([
        expect.stringContaining("database access belongs behind the Workbench API"),
      ]);
    }

    const [allowedResult] = await eslint.lintText(
      [
        'import auth from "@/lib/auth/workbench-auth.server";',
        'import contracts from "@workbench/workbench-contracts";',
        "void auth;",
        "void contracts;",
      ].join("\n"),
      { filePath: fixturePath },
    );
    expect(restrictedImportMessages(allowedResult.messages)).toEqual([]);

    const fixtureDirectory = await mkdtemp(path.join(
      webRoot,
      "components/workbench/.database-boundary-",
    ));
    const dependencyFixture = path.join(fixtureDirectory, "fixture.ts");
    await writeFile(
      dependencyFixture,
      'import database from "@workbench/workbench-db";\nvoid database;\n',
      "utf8",
    );
    try {
      const cruise = await runCommand(
        path.join(webRoot, "../../node_modules/.bin/depcruise"),
        [
          "--config",
          "../../.dependency-cruiser.cjs",
          relative(dependencyFixture),
        ],
        webRoot,
      );
      expect(cruise.code).toBe(1);
      expect(cruise.output).toContain("workbench-does-not-import-database-layer");
    } finally {
      await rm(fixtureDirectory, { force: true, recursive: true });
    }
  });
});

async function sourceGraph(): Promise<Map<string, SourceModule>> {
  const files = (await Promise.all(sourceRoots.map(sourceFiles)))
    .flat()
    .map((file) => path.resolve(file));
  const knownFiles = new Set(files);
  const graph = new Map<string, SourceModule>();

  await Promise.all(files.map(async (file) => {
    const source = await readFile(file, "utf8");
    const dependencies = moduleSpecifiers(file, source)
      .map((specifier) => resolveSourceModule(file, specifier, knownFiles))
      .filter((dependency): dependency is string => dependency !== null);
    graph.set(file, { dependencies, source });
  }));

  return graph;
}

async function sourceFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /[.](?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}

function moduleSpecifiers(file: string, source: string): string[] {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(ast);
  return specifiers;
}

function resolveSourceModule(
  source: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(webRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(source), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ].map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function featureLayer(file: string, featureRoot: string): string | null {
  return [...boundaryConfig.workbenchFeatureLayers, ...optionalFeatureLayers].find((layer) => (
    isInside(file, path.join(featureRoot, layer))
  )) ?? null;
}

function isInside(file: string, directory: string): boolean {
  const relativePath = path.relative(directory, file);
  return relativePath !== ""
    && !relativePath.startsWith(`..${path.sep}`)
    && relativePath !== ".."
    && !path.isAbsolute(relativePath);
}

function relative(file: string): string {
  return path.relative(webRoot, file);
}

function isDirective(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement)
    && ts.isStringLiteral(statement.expression);
}

function restrictedImportMessages(
  messages: readonly { message: string; ruleId: string | null }[],
): string[] {
  return messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

function restrictedSyntaxMessages(
  messages: readonly { message: string; ruleId: string | null }[],
): string[] {
  return messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}
