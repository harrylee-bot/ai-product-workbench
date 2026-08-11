import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { boardNodeProtocol, type PrototypeDocument } from "@workbench/workbench-contracts";
import {
  buildExport,
  renderExportHtml,
  TerminalExportError,
} from "../src/index.js";
import { designSystemExportRequest, exportRequest, interactiveExportRequest } from "./fixtures.js";

describe("Workbench export core", () => {
  it("renders a deterministic interactive standalone HTML document", async () => {
    const request = exportRequest("html");
    const first = await buildExport(request);
    const second = await buildExport(request);
    expect(first).toEqual(second);
    const html = new TextDecoder().decode(first.bytes);
    expect(first.mediaType).toBe("text/html; charset=utf-8");
    expect(html).toContain("workbench.export-runtime.v1");
    expect(html).toContain("action-next");
    expect(html).toContain('data-wb-screen="screen-success"');
    expect(html).not.toContain("https://");
  });

  it("packages HTML as a deterministic ZIP without creating a second render", async () => {
    const request = exportRequest("html");
    request.packaging = "zip";
    const output = await buildExport(request);
    const archive = unzipSync(output.bytes);
    expect(output.mediaType).toBe("application/zip");
    expect(output.fileName).toMatch(/\.zip$/);
    expect(output.validationTarget).toBe("html");
    expect(output.validationBytes).toBeInstanceOf(Uint8Array);
    expect(archiveText(archive, "index.html")).toContain("workbench.export-runtime.v1");
    const manifest = JSON.parse(archiveText(archive, "manifest.json")) as {
      protocol: string;
      document: { path: string; byteSize: number; sha256: string };
    };
    expect(manifest.protocol).toBe("workbench.html-package.v1");
    expect(manifest.document.path).toBe("index.html");
    expect(createHash("sha256").update(archive["index.html"]!).digest("hex")).toBe(manifest.document.sha256);
  });

  it("renders only the selected Prototype screen across HTML and React", async () => {
    const htmlRequest = exportRequest("html");
    htmlRequest.selection = {
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: "screen-success",
    };
    const html = new TextDecoder().decode((await buildExport(htmlRequest)).bytes);
    expect(html).toContain('data-wb-screen="screen-success"');
    expect(html).not.toContain('data-wb-screen="screen-home"');
    expect(html).not.toContain('data-wb-node="button-next"');

    const reactRequest = exportRequest("react");
    reactRequest.selection = { ...htmlRequest.selection };
    const react = unzipSync((await buildExport(reactRequest)).bytes);
    const app = archiveText(react, "src/App.jsx");
    expect(app).toContain('data-wb-screen="screen-success"');
    expect(app).not.toContain('data-wb-screen="screen-home"');
  }, 30_000);

  it("renders a complete Prototype Preview while honoring its selected initial screen", () => {
    const request = exportRequest("html");
    request.selection = {
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
    };
    request.initialScreenId = "screen-success";
    request.presentation = "preview";

    const rendered = renderExportHtml(request);
    const runtime = rendered.runtimeData as unknown as {
      prototypes: Array<{
        initialScreenId: string;
        screens: Array<{ id: string }>;
        actions: Array<{ id: string; kind: string; targetScreenId?: string }>;
      }>;
    };
    expect(rendered.document).toContain('data-wb-screen="screen-home"');
    expect(rendered.document).toContain('data-wb-screen="screen-success"');
    expect(rendered.bodyMarkup).toContain('data-wb-presentation="preview"');
    expect(rendered.bodyMarkup).toContain('class="wb-export wb-export--preview"');
    expect(runtime.prototypes[0]).toMatchObject({
      initialScreenId: "screen-success",
      screens: [{ id: "screen-home" }, { id: "screen-success" }],
    });
    expect(runtime.prototypes[0]!.actions).toContainEqual(expect.objectContaining({
      id: "action-next",
      kind: "navigate",
      targetScreenId: "screen-success",
    }));
  });

  it("derives a contrasting foreground for filled Prototype nodes", () => {
    const request = exportRequest("html");
    const prototype = request.source.artifacts[0]!.content as PrototypeDocument;
    const root = prototype.nodes.find((node) => node.id === "root-home");
    if (!root) throw new Error("fixture root is missing");
    root.style = { ...root.style, fill: { kind: "literal", value: "#111827" } };

    const darkHtml = renderExportHtml(request).document;
    expect(darkHtml).toMatch(/data-wb-node="root-home"[^>]*background-color:#111827;color:#fff/);

    root.style = { ...root.style, fill: { kind: "literal", value: "#ffffff" } };
    const lightHtml = renderExportHtml(request).document;
    expect(lightHtml).toMatch(/data-wb-node="root-home"[^>]*background-color:#ffffff;color:#17191d/);
  });

  it("treats text and icon fills as foreground colors", () => {
    const request = interactiveExportRequest();
    const prototype = request.source.artifacts[0]!.content as PrototypeDocument;
    const text = prototype.nodes.find((node) => node.id === "text-state");
    const icon = prototype.nodes.find((node) => node.id === "icon-heart");
    if (!text || !icon) throw new Error("interactive fixture nodes are missing");
    text.style = { ...text.style, fill: { kind: "literal", value: "#f1f3f4" } };
    icon.style = { ...icon.style, fill: { kind: "literal", value: "#2563eb" } };

    const html = renderExportHtml(request).document;
    expect(html).toMatch(/data-wb-node="text-state"[^>]*color:#f1f3f4/);
    expect(html).not.toMatch(/data-wb-node="text-state"[^>]*background-color:#f1f3f4/);
    expect(html).toMatch(/data-wb-node="icon-heart"[^>]*color:#2563eb/);
    expect(html).not.toMatch(/data-wb-node="icon-heart"[^>]*background-color:#2563eb/);
  });

  it("fails closed when screenId is missing or targets a non-Prototype Artifact", () => {
    const missing = exportRequest("html");
    missing.selection = {
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: "screen-missing",
    };
    expect(() => renderExportHtml(missing)).toThrow(expect.objectContaining({
      code: "EXPORT_SELECTION_SCREEN_NOT_FOUND",
    }));

    const wrongKind = designSystemExportRequest("html");
    wrongKind.selection = {
      kind: "artifact",
      artifactId: "artifact-design-system",
      artifactVersionId: "version-design-system",
      screenId: "screen-home",
    };
    expect(() => renderExportHtml(wrongKind)).toThrow(expect.objectContaining({
      code: "EXPORT_SELECTION_SCREEN_KIND_INVALID",
    }));

    const missingInitialScreen = exportRequest("html");
    missingInitialScreen.selection = {
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
    };
    missingInitialScreen.initialScreenId = "screen-missing";
    expect(() => renderExportHtml(missingInitialScreen)).toThrow(expect.objectContaining({
      code: "EXPORT_INITIAL_SCREEN_NOT_FOUND",
    }));
  });

  it("projects an exact multi-node Board selection across HTML, React, and MCP", async () => {
    const htmlRequest = multiNodeSelectionRequest("html");
    const html = new TextDecoder().decode((await buildExport(htmlRequest)).bytes);
    expect(html).toContain('data-board-node-id="node-1"');
    expect(html).toContain('data-board-node-id="frame-selected"');
    expect(html).toContain('data-board-node-id="frame-nested"');
    expect(html).toContain('data-board-node-id="drawing-descendant"');
    expect(html).not.toContain('data-board-node-id="drawing-unselected"');
    expect(html).toContain('data-artifact-version-id="version-1"');

    const react = unzipSync((await buildExport(multiNodeSelectionRequest("react"))).bytes);
    const app = archiveText(react, "src/App.jsx");
    expect(app).toContain('data-board-node-id="node-1"');
    expect(app).toContain('data-board-node-id="frame-selected"');
    expect(app).toContain('data-board-node-id="frame-nested"');
    expect(app).toContain('data-board-node-id="drawing-descendant"');
    expect(app).not.toContain('data-board-node-id="drawing-unselected"');

    const mcp = unzipSync((await buildExport(multiNodeSelectionRequest("mcp"))).bytes);
    const release = JSON.parse(archiveText(mcp, "release.json")) as {
      board: {
        nodes: Array<{ id: string }>;
        edges: Array<{ id: string }>;
      };
      artifacts: Array<{ artifactVersionId: string }>;
    };
    expect(release.board.nodes.map((node) => node.id).sort()).toEqual([
      "drawing-descendant",
      "frame-nested",
      "frame-selected",
      "node-1",
    ]);
    expect(release.board.edges.map((edge) => edge.id)).toEqual(["edge-selected"]);
    expect(release.artifacts.map((artifact) => artifact.artifactVersionId)).toEqual(["version-1"]);
  }, 30_000);

  it("fails closed when a Board-node selection is not pinned by the Release snapshot", () => {
    const request = exportRequest("html");
    request.selection = { kind: "board_nodes", nodeIds: ["node-outside-release"] };
    expect(() => renderExportHtml(request)).toThrow(expect.objectContaining({
      code: "EXPORT_BOARD_NODE_SELECTION_NOT_PINNED",
    }));
  });

  it("expresses one static Prototype transform consistently in HTML, React, and MCP", async () => {
    const html = renderExportHtml(exportRequest("html")).document;
    expect(html).toContain('data-wb-node="button-next" data-wb-rotation="30" data-wb-transform-origin-x="0.25" data-wb-transform-origin-y="0.75"');
    expect(html).toContain("transform:rotate(30deg);transform-box:border-box;transform-origin:25% 75%");

    const react = unzipSync((await buildExport(exportRequest("react"))).bytes);
    const app = archiveText(react, "src/App.jsx");
    expect(app).toContain('transform: "rotate(30deg)"');
    expect(app).toContain('transformOrigin: "25% 75%"');

    const mcp = unzipSync((await buildExport(exportRequest("mcp"))).bytes);
    const release = JSON.parse(archiveText(mcp, "release.json")) as {
      artifacts: Array<{ content: string }>;
    };
    const prototype = JSON.parse(release.artifacts[0]!.content) as {
      nodes: Array<{ id: string; style: { rotation: number; transformOrigin: { x: number; y: number } } }>;
    };
    expect(prototype.nodes.find((node) => node.id === "button-next")?.style).toMatchObject({
      rotation: 30,
      transformOrigin: { x: 0.25, y: 0.75 },
    });
  }, 30_000);

  it("renders nested Frames and freehand Drawings at their absolute Board positions", () => {
    const request = exportRequest("html");
    const artifact = request.source.boardSnapshot.nodes[0]!;
    artifact.parentNodeId = "frame-1";
    artifact.position = { x: 20, y: 30 };
    request.source.boardSnapshot.nodes = [
      {
        id: "frame-1",
        kind: "frame",
        parentNodeId: null,
        order: 0,
        position: { x: 100, y: 80 },
        size: { width: 520, height: 920 },
        artifactId: null,
        artifactVersionId: null,
        data: {
          protocol: boardNodeProtocol,
          nodeType: "frame",
          title: "Flow",
          fill: null,
          stroke: "#5f6368",
        },
      },
      artifact,
      {
        id: "drawing-1",
        kind: "drawing",
        parentNodeId: "frame-1",
        order: 1,
        position: { x: 60, y: 120 },
        size: { width: 80, height: 60 },
        artifactId: null,
        artifactVersionId: null,
        data: {
          protocol: boardNodeProtocol,
          nodeType: "drawing",
          title: "Annotation",
          stroke: {
            algorithm: "perfect-freehand@1",
            intrinsicSize: { width: 80, height: 60 },
            points: [[4, 4, 0.5], [76, 56, 0.7]],
            color: "#f1f3f4",
            size: 5,
            thinning: 0.55,
            smoothing: 0.65,
            streamline: 0.55,
            simulatePressure: true,
          },
        },
      },
    ];
    request.source.boardSnapshot.nodes.reverse();

    const html = renderExportHtml(request).document;
    expect(html).toContain('data-board-node-id="frame-1" style="left:40px;top:40px;width:520px;height:920px;z-index:0');
    expect(html).toContain('data-board-node-id="node-1" style="left:60px;top:70px;width:390px;height:844px;z-index:1');
    expect(html).toContain('data-board-node-id="drawing-1" style="left:100px;top:160px;width:80px;height:60px;z-index:2');
    expect(html.indexOf('data-board-node-id="frame-1"')).toBeLessThan(html.indexOf('data-board-node-id="node-1"'));
    expect(html.indexOf('data-board-node-id="node-1"')).toBeLessThan(html.indexOf('data-board-node-id="drawing-1"'));
    expect(html).toContain('viewBox="0 0 80 60" preserveAspectRatio="none" role="img" aria-label="Annotation"><path d="M ');
  });

  it("keeps a Drawing path in its intrinsic coordinate system when the Board node is resized", () => {
    const request = exportRequest("html");
    request.source.boardSnapshot.nodes = [{
      id: "drawing-resized",
      kind: "drawing",
      parentNodeId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 240, height: 30 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "drawing",
        title: "Resized annotation",
        stroke: {
          algorithm: "perfect-freehand@1",
          intrinsicSize: { width: 80, height: 60 },
          points: [[4, 4, 0.2], [76, 56, 0.9]],
          color: "#f1f3f4",
          size: 5,
          thinning: 0.55,
          smoothing: 0.65,
          streamline: 0.55,
          simulatePressure: false,
        },
      },
    }];

    const resizedHtml = renderExportHtml(request).document;
    const resizedPath = resizedHtml.match(/data-board-node-id="drawing-resized"[\s\S]*?<path d="([^"]+)"/)?.[1];
    expect(resizedHtml).toContain('width:240px;height:30px;z-index:0"><svg class="wb-board__drawing" viewBox="0 0 80 60"');

    request.source.boardSnapshot.nodes[0]!.size = { width: 80, height: 60 };
    const intrinsicHtml = renderExportHtml(request).document;
    const intrinsicPath = intrinsicHtml.match(/data-board-node-id="drawing-resized"[\s\S]*?<path d="([^"]+)"/)?.[1];
    expect(resizedPath).toBeTruthy();
    expect(resizedPath).toBe(intrinsicPath);
  });

  it("builds deterministic React and MCP archives with real compiled bundles", async () => {
    const reactA = await buildExport(exportRequest("react"));
    const reactB = await buildExport(exportRequest("react"));
    expect(reactA.bytes).toEqual(reactB.bytes);
    expect(Buffer.from(reactA.bytes).subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(archiveText(unzipSync(reactA.bytes), "README.md")).toContain("# 产品工作台 React 导出");
    const mcpA = await buildExport(exportRequest("mcp"));
    const mcpB = await buildExport(exportRequest("mcp"));
    expect(mcpA.bytes).toEqual(mcpB.bytes);
    expect(Buffer.from(mcpA.bytes).subarray(0, 4).toString("hex")).toBe("504b0304");
  }, 30_000);

  it("embeds pinned Design System images and fonts in standalone HTML", async () => {
    const first = await buildExport(designSystemExportRequest("html"));
    const second = await buildExport(designSystemExportRequest("html"));
    expect(first).toEqual(second);

    const html = new TextDecoder().decode(first.bytes);
    expect(html).toContain(designSystemImageDataUri);
    expect(html).toContain(designSystemFontDataUri);
    expect(html).toContain("@font-face");
    expect(html).toContain('data-wb-font-family="Workbench Brand"');
    expect(html).toContain("font-family:&quot;Workbench Brand&quot;");
    expect(html).toContain('data-wb-design-system="design-system-1"');
    expect(html).toContain('data-wb-asset-id="brand-image"');
    expect(html).toContain('data-wb-asset-id="brand-font"');
    expect(html).toContain(`data-wb-asset-sha256="${designSystemExportRequest("html").source.artifacts[0]!.assets[0]!.sha256}"`);
    expect(html).not.toContain("blob-brand-image");
    expect(html).not.toContain("blob-brand-font");
    expect(html).not.toContain("https://");

    const rendered = renderExportHtml(designSystemExportRequest("html"));
    expect(rendered.fontAssets).toEqual([
      expect.objectContaining({
        artifactVersionId: "version-design-system",
        assetId: "brand-font",
        family: "Workbench Brand",
        sha256: designSystemExportRequest("html").source.artifacts[0]!.assets[0]!.sha256,
      }),
    ]);
  });

  it("embeds Design System assets in editable React source and the compiled bundle", async () => {
    const first = await buildExport(designSystemExportRequest("react"));
    const second = await buildExport(designSystemExportRequest("react"));
    expect(first.bytes).toEqual(second.bytes);

    const archive = unzipSync(first.bytes);
    expect(archiveText(archive, "src/App.jsx")).toContain(designSystemImageDataUri);
    expect(archiveText(archive, "src/styles.css")).toContain(designSystemFontDataUri);
    expect(archiveText(archive, "dist/app.js")).toContain(designSystemImageDataUri);
    expect(archiveText(archive, "dist/app.css")).toContain(designSystemFontDataUri);
    for (const name of ["src/App.jsx", "src/styles.css", "dist/app.js", "dist/app.css"]) {
      expect(archiveText(archive, name)).not.toContain("blob-brand-");
    }
    const offlineDocument = archiveText(archive, "dist/index.html");
    expect(offlineDocument).toContain(designSystemImageDataUri);
    expect(offlineDocument).toContain(designSystemFontDataUri);
    expect(offlineDocument).toContain('<script type="module">');
    expect(offlineDocument).not.toContain('src="./app.js"');
    expect(offlineDocument).not.toContain('href="./app.css"');
  }, 30_000);

  it.each(["html", "react"] as const)("fails closed when %s Design System bytes drift without a pin change", async (format) => {
    const request = designSystemExportRequest(format);
    const font = request.source.artifacts[0]!.assets[0]!;
    font.bytes = Buffer.alloc(font.byteSize, 120);

    await expect(buildExport(request)).rejects.toMatchObject({
      code: "EXPORT_DESIGN_SYSTEM_ASSET_IDENTITY_MISMATCH",
    });
  });

  it("publishes deterministic MCP asset metadata and isolated binary resources", async () => {
    const request = designSystemExportRequest("mcp");
    const first = await buildExport(request);
    const second = await buildExport(designSystemExportRequest("mcp"));
    expect(first.bytes).toEqual(second.bytes);

    const archive = unzipSync(first.bytes);
    const releaseText = archiveText(archive, "release.json");
    const release = JSON.parse(releaseText) as {
      manifest: { artifacts: Array<Record<string, unknown>> };
      artifacts: Array<{ content: string; assets: Array<Record<string, unknown>> }>;
      assetResources: Array<Record<string, unknown>>;
    };
    const expected = [...request.source.artifacts[0]!.assets]
      .sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
    const expectedMetadata = expected.map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      uri: `workbench://artifact/version-design-system/asset/${asset.assetId}`,
      mimeType: asset.mediaType,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
    }));
    expect(release.artifacts[0]!.assets).toEqual(expectedMetadata);
    expect(release.assetResources).toEqual(expected.map((asset, assetPosition) => ({
      position: 0,
      assetPosition,
      artifactVersionId: "version-design-system",
      assetId: asset.assetId,
      uri: `workbench://artifact/version-design-system/asset/${asset.assetId}`,
      mimeType: asset.mediaType,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
      encoding: "base64",
      content: Buffer.from(asset.bytes).toString("base64"),
    })));
    expect(release.manifest.artifacts[0]).not.toHaveProperty("assets");
    expect(JSON.parse(release.artifacts[0]!.content)).not.toHaveProperty("assets.0.blobId");
    expect(releaseText).not.toContain('"blobId"');
    expect(archiveText(archive, "server.mjs")).toContain(
      "workbench://artifact/version-design-system/asset/brand-image",
    );
  }, 30_000);

  it("fails closed when MCP Design System asset bytes or pins drift", async () => {
    const changedBytes = designSystemExportRequest("mcp");
    const font = changedBytes.source.artifacts[0]!.assets[0]!;
    font.bytes = Buffer.alloc(font.byteSize, 120);
    await expect(buildExport(changedBytes)).rejects.toMatchObject({
      code: "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH",
    });

    const changedPin = designSystemExportRequest("mcp");
    changedPin.source.artifacts[0]!.assets[1]!.blobId = "blob-drifted";
    await expect(buildExport(changedPin)).rejects.toMatchObject({
      code: "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH",
    });

    const missingAsset = designSystemExportRequest("mcp");
    missingAsset.source.artifacts[0]!.assets.pop();
    await expect(buildExport(missingAsset)).rejects.toMatchObject({
      code: "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH",
    });
  });

  it("rejects unrecognized options and emits a versioned official-importer Figma package", async () => {
    const unsupported = exportRequest("html");
    unsupported.options = { surprise: true };
    await expect(buildExport(unsupported)).rejects.toMatchObject({ code: "EXPORT_OPTIONS_UNSUPPORTED" });
    const output = await buildExport(exportRequest("figma"));
    const archive = unzipSync(output.bytes);
    const document = JSON.parse(archiveText(archive, "figma-export.json"));
    const manifest = JSON.parse(archiveText(archive, "manifest.json"));
    expect(output.validationTarget).toBe("figma-package");
    expect(output.fileName).toBe("release-1-figma.zip");
    expect(document).toMatchObject({
      protocol: "workbench.figma-export.v1",
      schemaVersion: 1,
      importer: { minimumVersion: "1.0.0", pluginName: "产品工作台 Importer" },
      release: { id: "release-1", projectId: "project-1", version: 1 },
    });
    expect(document.prototypes).toHaveLength(1);
    expect(document.prototypes[0].selectedScreenIds).toEqual(["screen-home", "screen-success"]);
    expect(manifest.protocol).toBe("workbench.figma-package.v1");
    expect(archive).not.toHaveProperty("payload.bin");
    expect(archive).not.toHaveProperty("clipboard.html");
    expect(renderExportHtml(exportRequest()).document).toMatch(/^<!doctype html>/);
  }, 30_000);

  it("pins a single selected Prototype screen in the Figma Export document", async () => {
    const request = exportRequest("figma");
    request.selection = {
      kind: "artifact",
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: "screen-success",
    };
    const archive = unzipSync((await buildExport(request)).bytes);
    const document = JSON.parse(archiveText(archive, "figma-export.json"));
    expect(document.prototypes[0].selectedScreenIds).toEqual(["screen-success"]);
  }, 30_000);

  it("packages content-addressed Prototype assets and rejects byte drift", async () => {
    const request = exportRequest("figma");
    const artifact = request.source.artifacts[0]!;
    const document = artifact.content as PrototypeDocument;
    const bytes = Buffer.from("pinned-figma-image", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    document.assets.push({
      id: "asset-figma-image",
      kind: "image",
      name: "Pinned image",
      blobId: "blob-figma-image",
      mediaType: "image/png",
      byteSize: bytes.byteLength,
      sha256,
      width: 1,
      height: 1,
    });
    artifact.assets.push({
      assetId: "asset-figma-image",
      kind: "image",
      blobId: "blob-figma-image",
      mediaType: "image/png",
      byteSize: bytes.byteLength,
      sha256,
      bytes,
    });

    const archive = unzipSync((await buildExport(request)).bytes);
    expect(archive[`assets/${sha256}.png`]).toEqual(new Uint8Array(bytes));
    const figmaDocument = JSON.parse(archiveText(archive, "figma-export.json"));
    expect(figmaDocument.assets).toEqual([expect.objectContaining({
      artifactVersionId: "version-1",
      assetId: "asset-figma-image",
      sha256,
      archivePath: `assets/${sha256}.png`,
    })]);

    artifact.assets[0]!.bytes = Buffer.alloc(bytes.byteLength, 120);
    await expect(buildExport(request)).rejects.toMatchObject({
      code: "EXPORT_FIGMA_ASSET_IDENTITY_MISMATCH",
    });
  }, 30_000);
});

const designSystemImageDataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const designSystemFontDataUri = "data:font/woff2;base64,cGlubmVkLXRlc3QtZm9udA==";

function archiveText(archive: Record<string, Uint8Array>, name: string) {
  const entry = archive[name];
  if (!entry) throw new Error(`Missing archive entry: ${name}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(entry);
}

function multiNodeSelectionRequest(format: "html" | "react" | "mcp") {
  const request = exportRequest(format);
  request.source.boardSnapshot.nodes[0]!.parentNodeId = "frame-nested";
  request.source.boardSnapshot.nodes[0]!.order = 0;
  request.source.boardSnapshot.nodes.push(
    {
      id: "frame-selected",
      kind: "frame",
      parentNodeId: null,
      order: 0,
      position: { x: 440, y: 0 },
      size: { width: 300, height: 300 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame",
        title: "Selected notes",
        fill: null,
        stroke: "#5f6368",
      },
    },
    {
      id: "frame-nested",
      kind: "frame",
      parentNodeId: "frame-selected",
      order: 0,
      position: { x: 20, y: 20 },
      size: { width: 260, height: 180 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame",
        title: "Nested selected notes",
        fill: null,
        stroke: "#5f6368",
      },
    },
    {
      id: "drawing-descendant",
      kind: "drawing",
      parentNodeId: "frame-selected",
      order: 1,
      position: { x: 40, y: 220 },
      size: { width: 80, height: 60 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "drawing",
        title: "Selected annotation",
        stroke: {
          algorithm: "perfect-freehand@1",
          intrinsicSize: { width: 80, height: 60 },
          points: [[4, 4, 0.5], [76, 56, 0.7]],
          color: "#f1f3f4",
          size: 5,
          thinning: 0.55,
          smoothing: 0.65,
          streamline: 0.55,
          simulatePressure: true,
        },
      },
    },
    {
      id: "drawing-unselected",
      kind: "drawing",
      parentNodeId: null,
      order: 1,
      position: { x: 780, y: 0 },
      size: { width: 80, height: 60 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "drawing",
        title: "Unselected annotation",
        stroke: {
          algorithm: "perfect-freehand@1",
          intrinsicSize: { width: 80, height: 60 },
          points: [[4, 4, 0.5], [76, 56, 0.7]],
          color: "#f1f3f4",
          size: 5,
          thinning: 0.55,
          smoothing: 0.65,
          streamline: 0.55,
          simulatePressure: true,
        },
      },
    },
  );
  request.source.boardSnapshot.edges.push({
    id: "edge-to-unselected",
    sourceNodeId: "node-1",
    targetNodeId: "drawing-unselected",
    kind: "reference",
    data: {},
  }, {
    id: "edge-selected",
    sourceNodeId: "node-1",
    targetNodeId: "drawing-descendant",
    kind: "reference",
    data: {},
  });
  request.selection = {
    kind: "board_nodes",
    nodeIds: ["frame-selected"],
  };
  return request;
}
