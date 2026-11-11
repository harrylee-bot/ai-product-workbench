import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build, version as bundlerVersion, type Loader, type Plugin } from "esbuild";
import { parsers } from "prettier/plugins/babel";
import type { ParserOptions } from "prettier";
import {
  canonicalJson,
  sourcePrototypeDocumentSchema,
  sourcePrototypeInputSchema,
  type SourcePrototypeDocument,
  type SourcePrototypeInput,
} from "@workbench/workbench-contracts";
import { createDeterministicZip, type ArchiveEntry } from "./archive.js";
import { escapeHtml, safeFileStem } from "./encoding.js";
import { TerminalExportError } from "./errors.js";
import { exportedReactViteVersion } from "./react-package-toolchain.js";
import type { ExportArtifactSource, ExportBuildOutput, RenderedHtml } from "./types.js";

const require = createRequire(import.meta.url);
const renderer = "workbench.react-source.v1" as const;
const reactVersion = "19.2.3" as const;
const pinnedBundlerVersion = "0.28.1" as const;
const virtualNamespace = "workbench-source";
const bootstrapNamespace = "workbench-source-bootstrap";
const extensions = [".tsx", ".ts", ".jsx", ".js", ".json", ".css"] as const;
const allowedPackages = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"]);

/** Compile only the supplied in-memory project and the pinned React runtime.
 * Generated project package manifests, plugins and installation scripts are
 * never loaded or executed by this builder. The component executes only in
 * the browser document, under the existing isolated Preview boundary. */
export async function buildSourcePrototype(value: SourcePrototypeInput): Promise<SourcePrototypeDocument> {
  const parsed = sourcePrototypeInputSchema.safeParse(value);
  if (!parsed.success) throw new TerminalExportError("SOURCE_PROTOTYPE_INPUT_INVALID", "Source prototype input violates its bounded project contract", { cause: parsed.error });
  const input = parsed.data;
  verifyToolchain();
  await verifyStaticImports(input);
  const files = new Map(input.files.map((file) => [file.path, file.content]));
  const bootstrap = `import React from "react";import {createRoot} from "react-dom/client";import App from "workbench:entry";createRoot(document.getElementById("workbench-source-root")).render(React.createElement(App));`;
  const plugin: Plugin = {
    name: "workbench-bounded-source-project",
    setup(builder) {
      builder.onResolve({ filter: /^workbench:bootstrap$/ }, () => ({ path: "bootstrap.tsx", namespace: bootstrapNamespace }));
      builder.onResolve({ filter: /.*/, namespace: bootstrapNamespace }, (args) => {
        if (args.path === "workbench:entry") return { path: input.entryFile, namespace: virtualNamespace };
        return resolvePackage(args.path);
      });
      builder.onLoad({ filter: /.*/, namespace: bootstrapNamespace }, () => ({ contents: bootstrap, loader: "tsx" }));
      builder.onResolve({ filter: /.*/, namespace: virtualNamespace }, (args) => {
        if (allowedPackages.has(args.path)) return resolvePackage(args.path);
        if (args.kind === "url-token" && /^data:(?:image|font)\//u.test(args.path)) return { path: args.path, external: true };
        const target = relativeProjectFile(args.path, args.importer, files);
        return target ? { path: target, namespace: virtualNamespace } : { errors: [{ text: "Source import does not resolve to a supplied project file" }] };
      });
      builder.onLoad({ filter: /.*/, namespace: virtualNamespace }, (args) => {
        const contents = files.get(args.path);
        if (contents === undefined) return { errors: [{ text: "Source module is outside the supplied project" }] };
        return { contents, loader: path.posix.extname(args.path).slice(1) as Loader };
      });
    },
  };
  const output = await build({
    entryPoints: ["workbench:bootstrap"], bundle: true, write: false, outdir: "workbench-output",
    format: "iife", platform: "browser", target: ["es2022"], minify: true,
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "inline", sourcemap: false, charset: "utf8", plugins: [plugin], logLevel: "silent",
    supported: { "dynamic-import": false },
  }).catch((cause: unknown) => {
    throw new TerminalExportError("SOURCE_PROTOTYPE_BUILD_FAILED", "Source prototype did not compile with the supported local files and React imports", { cause });
  });
  const javaScript = output.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = output.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
  if (!javaScript) throw new TerminalExportError("SOURCE_PROTOTYPE_BUILD_EMPTY", "Source prototype browser bundle was empty");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(input.title)}</title><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}*{box-sizing:border-box}${inlineText(css, "style")}</style></head><body><div id="workbench-export-root" data-workbench-source-prototype="${escapeHtml(input.documentId)}"><div id="workbench-source-root"></div></div><script>${inlineText(javaScript, "script")}</script></body></html>`;
  const { protocol: _protocol, ...source } = input;
  const document = sourcePrototypeDocumentSchema.safeParse({ protocol: "workbench.prototype-source.v1", ...source,
    build: { renderer, reactVersion, bundlerVersion: pinnedBundlerVersion, sourceChecksum: sourcePrototypeInputChecksum(input), html, htmlSha256: sha256(html) } });
  if (!document.success) throw new TerminalExportError("SOURCE_PROTOTYPE_BUILD_LIMIT_EXCEEDED", "Compiled source prototype exceeded the frozen document contract", { cause: document.error });
  return document.data;
}

export function sourcePrototypeInputChecksum(input: SourcePrototypeInput): string {
  return sha256(canonicalJson(sourcePrototypeInputSchema.parse(input)));
}

/** Recheck both hashes every time an immutable source artifact is delivered. */
export function verifySourcePrototypeDocument(value: unknown): SourcePrototypeDocument {
  const parsed = sourcePrototypeDocumentSchema.safeParse(value);
  if (!parsed.success) throw new TerminalExportError("SOURCE_PROTOTYPE_DOCUMENT_INVALID", "Source prototype does not match its versioned document contract", { cause: parsed.error });
  const document = parsed.data;
  const { assets: _assets, build: frozen, protocol: _protocol, ...source } = document;
  const input = { protocol: "workbench.prototype-source-input.v1" as const, ...source };
  if (sourcePrototypeInputChecksum(input) !== frozen.sourceChecksum) throw new TerminalExportError("SOURCE_PROTOTYPE_SOURCE_CHECKSUM_MISMATCH", "Source prototype source changed after compilation");
  if (sha256(frozen.html) !== frozen.htmlSha256) throw new TerminalExportError("SOURCE_PROTOTYPE_HTML_CHECKSUM_MISMATCH", "Source prototype HTML changed after compilation");
  return document;
}

export function sourcePrototypeFromArtifact(artifact: ExportArtifactSource): SourcePrototypeDocument {
  if (artifact.kind !== "prototype" || artifact.schemaVersion !== 2 || artifact.content instanceof Uint8Array || artifact.contentMediaType !== "application/json") {
    throw new TerminalExportError("SOURCE_PROTOTYPE_ARTIFACT_INVALID", "Source prototype must be a ready structured schemaVersion 2 artifact");
  }
  if (sha256(canonicalJson(artifact.content)) !== artifact.checksum) throw new TerminalExportError("EXPORT_ARTIFACT_CHECKSUM_MISMATCH", "Source prototype does not match its immutable artifact checksum");
  return verifySourcePrototypeDocument(artifact.content);
}

export function renderSourcePrototype(document: SourcePrototypeDocument): RenderedHtml {
  return { document: document.build.html, bodyMarkup: "", styles: "", runtimeSource: "",
    runtimeData: { protocol: "workbench.prototype-source-export.v1", documentId: document.documentId }, fontAssets: [], title: document.title };
}

export async function sourcePrototypeReactOutput(artifact: ExportArtifactSource, packageName?: unknown): Promise<ExportBuildOutput> {
  const document = sourcePrototypeFromArtifact(artifact);
  if (packageName !== undefined && (typeof packageName !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName))) {
    throw new TerminalExportError("EXPORT_REACT_PACKAGE_NAME_INVALID", "React packageName must be a valid lowercase npm package name");
  }
  const mainPath = "workbench/main.jsx";
  const main = `import React from "react";import {createRoot} from "react-dom/client";import App from ${JSON.stringify("../source/" + document.entryFile)};createRoot(document.getElementById("workbench-source-root")).render(React.createElement(App));\n`;
  const packageJson = { name: packageName ?? "workbench-source-prototype", version: "1.0.0", private: true, type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { react: reactVersion, "react-dom": reactVersion }, devDependencies: { vite: exportedReactViteVersion } };
  const toolchainManifest = { protocol: "workbench.source-package.v1", sourceChecksum: document.build.sourceChecksum,
    htmlSha256: document.build.htmlSha256, renderer, reactVersion, bundlerVersion: pinnedBundlerVersion,
    entryFile: document.entryFile, files: document.files.map((file) => ({ path: file.path, sha256: sha256(file.content) })) };
  const entries: ArchiveEntry[] = [
    ...document.files.map((file) => ({ name: "source/" + file.path, content: file.content })),
    { name: "package.json", content: JSON.stringify(packageJson, null, 2) + "\n" },
    { name: mainPath, content: main },
    { name: "index.html", content: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title)}</title></head><body><div id="workbench-source-root"></div><script type="module" src="/${mainPath}"></script></body></html>\n` },
    { name: "dist/index.html", content: document.build.html },
    { name: "workbench-source.json", content: canonicalJson(document) + "\n" },
    { name: "workbench-build.json", content: canonicalJson(toolchainManifest) + "\n" },
    { name: "README.md", content: "# 产品工作台源码原型\n\n打开 `dist/index.html` 可离线查看固定版本。原始源码按原路径保留在 `source/` 下；`npm install && npm run dev` 可在独立开发环境编辑。入口须默认导出 React 组件。`workbench-build.json` 记录该版本的源码、构建产物与固定工具版本。\n" },
    { name: "licenses/react-LICENSE.txt", content: readFileSync(require.resolve("react/package.json").replace(/package\.json$/u, "LICENSE"), "utf8") },
    { name: "licenses/react-dom-LICENSE.txt", content: readFileSync(require.resolve("react-dom/package.json").replace(/package\.json$/u, "LICENSE"), "utf8") },
  ];
  const bytes = await createDeterministicZip(entries);
  return { bytes, mediaType: "application/zip", fileName: `${safeFileStem(document.title)}-react.zip`, validationTarget: "html", validationBytes: Buffer.from(document.build.html, "utf8") };
}

async function verifyStaticImports(input: SourcePrototypeInput) {
  const files = new Map(input.files.map((file) => [file.path, file.content]));
  for (const file of input.files) {
    if (!/\.(?:tsx|jsx|ts|js)$/u.test(file.path)) continue;
    let ast: unknown;
    try {
      ast = await parsers["babel-ts"]!.parse(file.content, { parser: "babel-ts", filepath: file.path } as ParserOptions);
    } catch (cause) {
      throw new TerminalExportError("SOURCE_PROTOTYPE_BUILD_FAILED", "Source prototype contains invalid JavaScript or TypeScript", { cause });
    }
    const pending: unknown[] = [ast];
    const seen = new WeakSet<object>();
    while (pending.length) {
      const value = pending.pop();
      if (value === null || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) { pending.push(...value); continue; }
      const node = value as Record<string, unknown>;
      const callee = node.callee as Record<string, unknown> | undefined;
      const staticDeclaration = node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration";
      const loader = staticDeclaration ? (node.source ?? undefined)
        : node.type === "TSImportType" ? node.argument
        : node.type === "ImportExpression" ? node.source
        : (node.type === "CallExpression" || node.type === "OptionalCallExpression")
          && (callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require"))
          ? (node.arguments as unknown[] | undefined)?.[0] : undefined;
      if (loader !== undefined) {
        const literal = loader as Record<string, unknown> | null;
        if (!literal || literal.type !== "StringLiteral" || typeof literal.value !== "string") {
          throw new TerminalExportError("SOURCE_PROTOTYPE_DYNAMIC_IMPORT_UNSUPPORTED", "Source imports must name static supplied project files or pinned React modules");
        }
        if (!allowedPackages.has(literal.value) && !relativeProjectFile(literal.value, file.path, files)) {
          throw new TerminalExportError("SOURCE_PROTOTYPE_BUILD_FAILED", "Source imports must remain inside supplied files and pinned React runtime modules");
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== "tokens" && key !== "comments" && child !== null && typeof child === "object") pending.push(child);
      }
    }
  }
}

function relativeProjectFile(specifier: string, importer: string, files: ReadonlyMap<string, string>): string | undefined {
  if ((!specifier.startsWith("./") && !specifier.startsWith("../")) || /[\\\0?#]/u.test(specifier)) return undefined;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (relative === ".." || relative.startsWith("../") || relative.startsWith("/")) return undefined;
  return [relative, ...extensions.map((extension) => relative + extension), ...extensions.map((extension) => relative + "/index" + extension)]
    .find((candidate) => files.has(candidate));
}

function resolvePackage(specifier: string) {
  if (!allowedPackages.has(specifier)) return deniedImport(specifier);
  return { path: require.resolve(specifier) };
}

function deniedImport(_specifier: string) {
  return { errors: [{ text: "Only supplied relative project files and pinned React runtime modules may be imported" }] };
}

function verifyToolchain() {
  const react = JSON.parse(readFileSync(require.resolve("react/package.json"), "utf8")) as { version?: string };
  const reactDom = JSON.parse(readFileSync(require.resolve("react-dom/package.json"), "utf8")) as { version?: string };
  if (react.version !== reactVersion || reactDom.version !== reactVersion || bundlerVersion !== pinnedBundlerVersion) {
    throw new TerminalExportError("SOURCE_PROTOTYPE_TOOLCHAIN_MISMATCH", "Source prototype builder dependencies differ from the pinned toolchain");
  }
}

function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function inlineText(value: string, kind: "script" | "style") { return value.replace(new RegExp(`</${kind}`, "giu"), `<\\/${kind}`); }
