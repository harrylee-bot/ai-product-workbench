import { build } from "esbuild";
import { htmlToJsx } from "html-to-jsx-transform";
import { format } from "prettier";
import { createDeterministicZip, type ArchiveEntry } from "./archive.js";
import { safeFileStem, safeScriptJson } from "./encoding.js";
import { TerminalExportError } from "./errors.js";
import { renderExportHtml } from "./html-renderer.js";
import { exportedReactViteVersion } from "./react-package-toolchain.js";
import { reactRuntimeModuleSource } from "./runtime-source.js";
import type { ExportBuildRequest } from "./types.js";

export async function reactOutput(request: ExportBuildRequest) {
  const rendered = renderExportHtml(request);
  let jsx: string;
  try {
    jsx = htmlToJsx(rendered.bodyMarkup);
  } catch (cause) {
    throw new TerminalExportError("EXPORT_REACT_TRANSFORM_FAILED", "Generated HTML could not be converted to JSX", { cause });
  }
  const appSource = await format(`
    import { useEffect, useRef } from "react";
    import { installWorkbenchRuntime } from "./runtime.js";
    import runtimeData from "./runtime-data.json";
    import "./styles.css";

    export default function App() {
      const root = useRef(null);
      useEffect(() => {
        if (root.current) installWorkbenchRuntime(root.current, runtimeData);
      }, []);
      return <div id="workbench-export-root" ref={root}>${jsx}</div>;
    }
  `, { parser: "babel" });
  const mainSource = await format(`
    import { StrictMode } from "react";
    import { createRoot } from "react-dom/client";
    import App from "./App.jsx";
    createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
  `, { parser: "babel" });
  const runtimeSource = await format(reactRuntimeModuleSource(), { parser: "babel" });
  const packageName = reactPackageName(request);
  const packageJson = `${JSON.stringify({
    name: packageName,
    private: true,
    version: "1.0.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { react: "19.2.3", "react-dom": "19.2.3" },
    devDependencies: { vite: exportedReactViteVersion },
  }, null, 2)}\n`;
  const indexHtml = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeForHtml(rendered.title)}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`;

  const virtualFiles = new Map<string, { contents: string; loader: "jsx" | "js" | "json" | "css" }>([
    ["/src/main.jsx", { contents: mainSource, loader: "jsx" }],
    ["/src/App.jsx", { contents: appSource, loader: "jsx" }],
    ["/src/runtime.js", { contents: runtimeSource, loader: "js" }],
    ["/src/runtime-data.json", { contents: safeScriptJson(rendered.runtimeData), loader: "json" }],
    ["/src/styles.css", { contents: rendered.styles, loader: "css" }],
  ]);
  const built = await build({
    entryPoints: ["/src/main.jsx"],
    bundle: true,
    write: false,
    outdir: "dist",
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    sourcemap: false,
    jsx: "automatic",
    plugins: [{
      name: "workbench-export-virtual-source",
      setup(plugin) {
        plugin.onResolve({ filter: /^\// }, (args) => ({ path: args.path, namespace: "workbench" }));
        plugin.onResolve({ filter: /^\.\//, namespace: "workbench" }, (args) => ({
          path: new URL(args.path, `file://${args.importer}`).pathname,
          namespace: "workbench",
        }));
        plugin.onLoad({ filter: /.*/, namespace: "workbench" }, (args) => {
          const source = virtualFiles.get(args.path);
          if (!source) return { errors: [{ text: `Unknown virtual module: ${args.path}` }] };
          return { ...source, resolveDir: process.cwd() };
        });
      },
    }],
  }).catch((cause: unknown) => {
    throw new TerminalExportError("EXPORT_REACT_BUILD_FAILED", "Generated React source did not compile", { cause });
  });
  const appJavaScript = built.outputFiles.find((file) => file.path.endsWith(".js"));
  const appStyles = built.outputFiles.find((file) => file.path.endsWith(".css"));
  if (!appJavaScript || appJavaScript.contents.byteLength === 0) {
    throw new TerminalExportError("EXPORT_REACT_BUILD_EMPTY", "Generated React browser bundle was empty");
  }

  const entries: ArchiveEntry[] = [
    { name: "package.json", content: packageJson },
    { name: "index.html", content: indexHtml },
    { name: "src/main.jsx", content: mainSource },
    { name: "src/App.jsx", content: appSource },
    { name: "src/runtime.js", content: runtimeSource },
    { name: "src/runtime-data.json", content: `${safeScriptJson(rendered.runtimeData)}\n` },
    { name: "src/styles.css", content: `${rendered.styles}\n` },
    { name: "README.md", content: "# 产品工作台 React 导出\n\nThis archive contains editable React source and a self-contained prebuilt browser document at `dist/index.html`. Open that file directly for offline viewing. Run `npm install && npm run dev` for local editing.\n" },
    {
      name: "dist/index.html",
      content: productionIndex(rendered.title, appJavaScript.contents, appStyles?.contents),
    },
  ];
  for (const output of built.outputFiles) {
    if (output.path.endsWith(".js")) entries.push({ name: "dist/app.js", content: output.contents });
    if (output.path.endsWith(".css")) entries.push({ name: "dist/app.css", content: output.contents });
  }
  const bytes = await createDeterministicZip(entries);
  return {
    bytes,
    mediaType: "application/zip",
    fileName: `${safeFileStem(rendered.title)}-react.zip`,
    validationTarget: "archive" as const,
  };
}

function productionIndex(title: string, javaScript: Uint8Array, styles?: Uint8Array) {
  const css = styles ? `<style>${inlineArchiveText(styles, "style")}</style>` : "";
  const script = inlineArchiveText(javaScript, "script");
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeForHtml(title)}</title>${css}</head><body><div id="root"></div><script type="module">${script}</script></body></html>\n`;
}

function inlineArchiveText(bytes: Uint8Array, element: "script" | "style") {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const closingTag = new RegExp(`</${element}`, "gi");
  return text.replace(closingTag, `<\\/${element}`);
}

function reactPackageName(request: ExportBuildRequest) {
  const requested = request.options.packageName;
  if (requested !== undefined && (typeof requested !== "string" || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$|^[a-z0-9][a-z0-9._-]*$/.test(requested))) {
    throw new TerminalExportError("EXPORT_REACT_PACKAGE_NAME_INVALID", "React packageName must be a valid lowercase npm package name");
  }
  return typeof requested === "string" ? requested : `workbench-release-${request.source.releaseVersion}`;
}

function escapeForHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
