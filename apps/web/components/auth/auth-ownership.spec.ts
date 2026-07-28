import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const authRouteRoot = path.join(webRoot, "app/(auth)");
const authComponentRoot = path.join(webRoot, "components/auth");
const legacyChatRoot = path.join(webRoot, "components/chat");

describe("authentication UI ownership", () => {
  it("keeps auth routes and components independent from legacy chat UI", async () => {
    const files = (
      await Promise.all([
        sourceFiles(authRouteRoot),
        sourceFiles(authComponentRoot),
      ])
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of moduleSpecifiers(file, source)) {
        const dependency = resolveLocalModule(file, specifier);
        if (dependency && isInsideOrEqual(dependency, legacyChatRoot)) {
          violations.push(`${relative(file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("routes every auth presentation dependency through auth-owned modules", async () => {
    await expectImports("app/(auth)/login/login-page.tsx", [
      "@/components/auth/auth-form",
      "@/components/auth/auth-submit-button",
      "@/components/auth/auth-toast",
    ]);
    await expectImports("app/(auth)/register/register-page.tsx", [
      "@/components/auth/auth-icons",
      "@/components/auth/auth-toast",
    ]);
    await expectImports("app/(auth)/layout.tsx", [
      "@/components/auth/auth-spotlight-shell",
      "@/components/auth/auth-toast",
    ]);
  });

  it("mounts exactly one auth-owned toaster in the auth layout", async () => {
    const file = path.join(authRouteRoot, "layout.tsx");
    const source = await readFile(file, "utf8");
    const ast = createAst(file, source);
    let toasterMounts = 0;

    const visit = (node: ts.Node) => {
      if (
        ts.isJsxSelfClosingElement(node)
        && ts.isIdentifier(node.tagName)
        && node.tagName.text === "AuthToaster"
      ) {
        toasterMounts += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    expect(toasterMounts).toBe(1);
  });

  it("wires the legacy-chat restriction into ESLint", async () => {
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
    const [result] = await eslint.lintText(
      'import { toast } from "@/components/chat/toast";\nvoid toast;\n',
      { filePath: path.join(authComponentRoot, "auth-form.tsx") },
    );

    expect(
      result.messages
        .filter((message) => message.ruleId === "no-restricted-imports")
        .map((message) => message.message),
    ).toEqual([
      expect.stringContaining("cannot depend on the legacy chat UI"),
    ]);
  });
});

async function expectImports(relativePath: string, expected: readonly string[]) {
  const file = path.join(webRoot, relativePath);
  const source = await readFile(file, "utf8");
  const actual = moduleSpecifiers(file, source);

  for (const specifier of expected) {
    expect(actual, `${relativePath} must import ${specifier}`).toContain(specifier);
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /[.](?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}

function moduleSpecifiers(file: string, source: string): string[] {
  const ast = createAst(file, source);
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
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return specifiers;
}

function createAst(file: string, source: string) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function resolveLocalModule(source: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) {
    return path.resolve(webRoot, specifier.slice(2));
  }
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(source), specifier);
  }
  return null;
}

function isInsideOrEqual(file: string, directory: string): boolean {
  const relativePath = path.relative(directory, file);
  return relativePath === ""
    || (
      !relativePath.startsWith(`..${path.sep}`)
      && relativePath !== ".."
      && !path.isAbsolute(relativePath)
    );
}

function relative(file: string) {
  return path.relative(webRoot, file);
}
