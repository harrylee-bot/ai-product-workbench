import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";
import { canonicalJson, type SourcePrototypeDocument, type SourcePrototypeInput } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";
import { buildExport, buildSourcePrototype, renderExportHtml, verifySourcePrototypeDocument } from "../src/index.js";
import { exportRequest } from "./fixtures.js";

function input(): SourcePrototypeInput {
  return { protocol: "workbench.prototype-source-input.v1", documentId: "source-checkout", title: "采购审批", revision: 1,
    summary: "采购人填写申请，审批人查看并提交审批。", entryFile: "src/App.tsx", pages: [{ id: "request", name: "采购申请", route: "/" }],
    files: [
      { path: "src/App.tsx", content: 'import React, {useState} from "react";import {Label} from "./components/Label";import copy from "./copy.json";import "./styles.css";export default function App(){const [count,setCount]=useState(0);return <main><h1><Label text={copy.title}/></h1><button onClick={()=>setCount(count+1)}>提交审批 {count}</button></main>}' },
      { path: "src/components/Label.tsx", content: 'import React from "react";export function Label({text}:{text:string}){return <span>{text}</span>}' },
      { path: "src/copy.json", content: '{"title":"采购申请"}' },
      { path: "src/styles.css", content: 'main{padding:24px}button{padding:12px 20px;color:#fff;background:#6757e8;border:0;border-radius:8px}' },
    ] };
}

function request(document: SourcePrototypeDocument, format: "html" | "react" = "html") {
  const value = exportRequest(format);
  const artifact = value.source.artifacts[0]!;
  artifact.kind = "prototype";
  artifact.schemaVersion = 2;
  artifact.content = document;
  artifact.checksum = sha(canonicalJson(document));
  artifact.assets = [];
  value.selection = { kind: "artifact", artifactId: artifact.artifactId, artifactVersionId: artifact.artifactVersionId };
  return value;
}

function sha(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function textEntry(entries: Record<string, Uint8Array>, name: string) { const data = entries[name]; if (!data) throw new Error(`Missing ${name}`); return new TextDecoder("utf-8", { fatal: true }).decode(data); }

const executablePath = chromium.executablePath();

describe("Source prototype immutable build and delivery", () => {
  it("bundles supplied TSX, JSON and CSS deterministically with a pinned runtime", async () => {
    const first = await buildSourcePrototype(input());
    const second = await buildSourcePrototype(input());
    expect(first).toEqual(second);
    expect(first.build.sourceChecksum).toBe(sha(canonicalJson(input())));
    expect(first.build.htmlSha256).toBe(sha(first.build.html));
    expect(first.build.html).toContain('id="workbench-export-root"');
    expect(first.build.html).toContain('id="workbench-source-root"');
    expect(first.build.html).not.toMatch(/<script[^>]+src=/iu);
    expect(first.build.html).not.toMatch(/<link[^>]+href=/iu);
    expect(first.build.reactVersion).toBe("19.2.3");
    expect(first.build.bundlerVersion).toBe("0.28.1");
    expect(verifySourcePrototypeDocument(first)).toEqual(first);
  });

  it.each(["node:fs", "fs", "/etc/passwd", "https://example.com/module.js", "react/package.json", "../../../../outside"])("rejects imports outside the supplied project: %s", async (specifier) => {
    const source = input();
    source.files[0]!.content = `import anything from ${JSON.stringify(specifier)};export default function App(){return String(anything)}`;
    await expect(buildSourcePrototype(source)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_BUILD_FAILED" });
  });

  it("rejects forbidden unused imports and imports in files outside the entry graph", async () => {
    const unused = input();
    unused.files[0]!.content = 'import fs from "node:fs";export default function App(){return <p>Unused import</p>}';
    await expect(buildSourcePrototype(unused)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_BUILD_FAILED" });
    const unreferenced = input();
    unreferenced.files.push({ path: "src/unused.ts", content: 'export {readFile} from "node:fs"' });
    await expect(buildSourcePrototype(unreferenced)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_BUILD_FAILED" });
  });

  it.each(['import(name)', 'require(name)'])("rejects a nonliteral module loader: %s", async (expression) => {
    const source = input();
    source.files[0]!.content = `export default function App(){const name="./copy.json";return ${expression}}`;
    await expect(buildSourcePrototype(source)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_DYNAMIC_IMPORT_UNSUPPORTED" });
  });

  it("does not mistake import-like text in strings and comments for a dynamic loader", async () => {
    const source = input();
    source.files[0]!.content = '/* import(variable) */ export default function App(){return <p>{"import(name)"}</p>}';
    await expect(buildSourcePrototype(source)).resolves.toHaveProperty("build.htmlSha256");
  });

  it("rejects oversized and escaping virtual files before compilation", async () => {
    const traversal = input();
    traversal.files[0]!.path = "../App.tsx";
    traversal.entryFile = "../App.tsx";
    await expect(buildSourcePrototype(traversal)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_INPUT_INVALID" });
    const oversized = input();
    oversized.files[0]!.content = "汉".repeat(64 * 1024);
    await expect(buildSourcePrototype(oversized)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_INPUT_INVALID" });
  });

  it("rejects source, compiled HTML and artifact checksum drift at delivery", async () => {
    const document = await buildSourcePrototype(input());
    const sourceDrift = structuredClone(document);
    sourceDrift.files[0]!.content += "\n// drift";
    expect(() => verifySourcePrototypeDocument(sourceDrift)).toThrow(/SOURCE_PROTOTYPE_SOURCE_CHECKSUM_MISMATCH/u);
    const htmlDrift = structuredClone(document);
    htmlDrift.build.html += "changed";
    expect(() => verifySourcePrototypeDocument(htmlDrift)).toThrow(/SOURCE_PROTOTYPE_HTML_CHECKSUM_MISMATCH/u);
    const value = request(document);
    value.source.artifacts[0]!.checksum = "0".repeat(64);
    await expect(buildExport(value)).rejects.toMatchObject({ code: "EXPORT_ARTIFACT_CHECKSUM_MISMATCH" });
  });

  it("delivers the same frozen HTML through single-file and ZIP exports", async () => {
    const document = await buildSourcePrototype(input());
    const value = request(document);
    const html = await buildExport(value);
    expect(new TextDecoder().decode(html.bytes)).toBe(document.build.html + "\n");
    value.packaging = "zip";
    const zip = await buildExport(value);
    expect(textEntry(unzipSync(zip.bytes), "index.html")).toBe(document.build.html + "\n");
    expect(zip.validationTarget).toBe("html");
    expect(new TextDecoder().decode(zip.validationBytes)).toBe(document.build.html + "\n");
  });

  it("preserves editable sources, frozen browser content and toolchain metadata in a deterministic React ZIP", async () => {
    const document = await buildSourcePrototype(input());
    const first = await buildExport(request(document, "react"));
    const second = await buildExport(request(document, "react"));
    expect(first.bytes).toEqual(second.bytes);
    const entries = unzipSync(first.bytes);
    expect(textEntry(entries, "source/src/App.tsx")).toBe(document.files[0]!.content);
    expect(textEntry(entries, "dist/index.html")).toBe(document.build.html);
    expect(textEntry(entries, "workbench/main.jsx")).toContain('../source/src/App.tsx');
    expect(JSON.parse(textEntry(entries, "package.json")).dependencies).toEqual({ react: "19.2.3", "react-dom": "19.2.3" });
    expect(JSON.parse(textEntry(entries, "workbench-build.json"))).toMatchObject({ sourceChecksum: document.build.sourceChecksum, htmlSha256: document.build.htmlSha256 });
    expect(textEntry(entries, "licenses/react-LICENSE.txt")).toContain("MIT License");
    expect(first.validationTarget).toBe("html");
  });

  it("keeps mixed selections, legacy screen selection and unsupported formats explicit", async () => {
    const document = await buildSourcePrototype(input());
    const mixed = request(document);
    mixed.selection = { kind: "release" };
    expect(() => renderExportHtml(mixed)).toThrow(/SOURCE_PROTOTYPE_SELECTION_UNSUPPORTED/u);
    const screen = request(document);
    screen.selection = { ...screen.selection as { kind: "artifact"; artifactId: string; artifactVersionId: string }, screenId: "request" };
    await expect(buildExport(screen)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_SCREEN_SELECTION_UNSUPPORTED" });
    const figma = request(document);
    figma.format = "figma";
    figma.packaging = "zip";
    await expect(buildExport(figma)).rejects.toMatchObject({ code: "SOURCE_PROTOTYPE_FORMAT_UNSUPPORTED" });
  });

  it.runIf(existsSync(executablePath))("renders and updates React state in an opaque sandbox without external requests", async () => {
    const document = await buildSourcePrototype(input());
    const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: false, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const network: string[] = [];
    await context.route(/^(?:https?|wss?):/iu, (route) => { network.push(route.request().url()); return route.abort("blockedbyclient"); });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setContent('<iframe name="prototype" sandbox="allow-scripts" style="width:100%;height:800px;border:0"></iframe>');
      const frame = page.frame({ name: "prototype" })!;
      await page.locator("iframe").evaluate((element, html) => { (element as HTMLIFrameElement).srcdoc = html; }, document.build.html);
      await frame.getByRole("heading", { name: "采购申请" }).waitFor();
      await frame.getByRole("button", { name: "提交审批 0" }).click();
      await frame.getByRole("button", { name: "提交审批 1" }).waitFor();
      expect(await frame.evaluate(() => location.origin)).toBe("null");
      expect(network).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);
});
