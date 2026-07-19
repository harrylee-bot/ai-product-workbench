import { createHash } from "node:crypto";
import { build } from "esbuild";
import { format } from "prettier";
import {
  canonicalJson,
  designSystemDocumentSchema,
  prototypeDocumentSchema,
  publicDesignSystemDocumentSchema,
  publicProjectReleaseManifestSchema,
  publicPrototypeDocumentSchema,
  type JsonValue,
} from "@workbench/workbench-contracts";
import { createDeterministicZip } from "./archive.js";
import { safeFileStem, safeScriptJson } from "./encoding.js";
import { TerminalExportError } from "./errors.js";
import { selectExportArtifacts, selectExportBoardSnapshot } from "./html-renderer.js";
import type { ExportArtifactSource, ExportBuildRequest } from "./types.js";

export async function mcpOutput(request: ExportBuildRequest) {
  const payload = mcpPayload(request);
  const serverName = mcpServerName(request);
  const source = await format(`
    import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { z } from "zod";
    const release = ${safeScriptJson(payload)};
    const server = new McpServer({ name: ${JSON.stringify(serverName)}, version: "1.0.0" });
    const asText = (value) => JSON.stringify(value, null, 2);

    server.registerResource("release-manifest", "workbench://release/manifest", { title: "Project release manifest", mimeType: "application/json" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: asText(release.manifest) }],
    }));
    server.registerResource("release-board", "workbench://release/board", { title: "Project release board", mimeType: "application/json" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: asText(release.board) }],
    }));
    for (const artifact of release.artifacts) {
      const uri = "workbench://artifact/" + encodeURIComponent(artifact.artifactId) + "/" + encodeURIComponent(artifact.artifactVersionId);
      server.registerResource("artifact-" + artifact.position, uri, { title: artifact.title, mimeType: artifact.contentMediaType }, async () => ({
        contents: artifact.encoding === "base64"
          ? [{ uri, mimeType: artifact.contentMediaType, blob: artifact.content }]
          : [{ uri, mimeType: artifact.contentMediaType, text: artifact.content }],
      }));
    }
    for (const asset of release.assetResources) {
      server.registerResource(
        "artifact-asset-" + asset.position + "-" + asset.assetPosition,
        asset.uri,
        { title: asset.assetId, mimeType: asset.mimeType },
        async () => ({
          contents: [{ uri: asset.uri, mimeType: asset.mimeType, blob: asset.content }],
        }),
      );
    }
    server.registerTool("list_artifacts", {
      title: "List pinned artifacts",
      description: "List immutable ArtifactVersions pinned by this ProjectRelease",
      outputSchema: { artifacts: z.array(z.object({ artifactId: z.string(), artifactVersionId: z.string(), kind: z.string(), title: z.string(), version: z.number() })) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => {
      const artifacts = release.artifacts.map(({ artifactId, artifactVersionId, kind, title, version }) => ({ artifactId, artifactVersionId, kind, title, version }));
      return { content: [{ type: "text", text: asText(artifacts) }], structuredContent: { artifacts } };
    });
    server.registerTool("get_artifact", {
      title: "Read a pinned artifact",
      description: "Read one immutable ArtifactVersion by artifactVersionId",
      inputSchema: { artifactVersionId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ artifactVersionId }) => {
      const artifact = release.artifacts.find((candidate) => candidate.artifactVersionId === artifactVersionId);
      if (!artifact) return { isError: true, content: [{ type: "text", text: "ArtifactVersion is not pinned by this release" }] };
      return {
        content: [{
          type: "text",
          text: asText({
            ...artifact,
            content: artifact.encoding === "base64" ? "[base64 omitted]" : artifact.content,
          }),
        }],
      };
    });
    await server.connect(new StdioServerTransport());
  `, { parser: "babel" });
  const built = await build({
    stdin: { contents: source, sourcefile: "server.mjs", resolveDir: process.cwd(), loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: ["node22"],
    minify: false,
    legalComments: "none",
    sourcemap: false,
  }).catch((cause: unknown) => {
    throw new TerminalExportError("EXPORT_MCP_BUILD_FAILED", "Generated MCP server did not compile", { cause });
  });
  const bundle = built.outputFiles[0];
  if (!bundle || bundle.contents.byteLength === 0) {
    throw new TerminalExportError("EXPORT_MCP_BUILD_EMPTY", "Generated MCP server bundle was empty");
  }
  const packageJson = `${JSON.stringify({ name: serverName, private: true, version: "1.0.0", type: "module", bin: { [serverName]: "server.mjs" }, engines: { node: ">=22" } }, null, 2)}\n`;
  const bytes = await createDeterministicZip([
    { name: "package.json", content: packageJson },
    { name: "server.mjs", content: bundle.contents, mode: 0o755 },
    { name: "release.json", content: `${canonicalJson(payload)}\n` },
    { name: "README.md", content: `# ${serverName}\n\nImmutable ProjectRelease MCP server. Configure your MCP client to run \`node /absolute/path/server.mjs\`. It exposes release/board resources and read-only artifact tools over stdio.\n` },
  ]);
  return {
    bytes,
    mediaType: "application/zip",
    fileName: `${safeFileStem(serverName)}-mcp.zip`,
    validationTarget: "archive" as const,
  };
}

export function mcpPayload(request: ExportBuildRequest) {
  const selected = selectExportArtifacts(
    request.source.artifacts,
    request.selection,
    request.source.boardSnapshot.nodes,
  );
  const prepared = selected.map((artifact) => ({
    artifact,
    assets: validatedArtifactAssets(artifact),
  }));
  return {
    protocol: "workbench.mcp-export.v1",
    releaseId: request.source.releaseId,
    projectId: request.source.projectId,
    releaseVersion: request.source.releaseVersion,
    manifest: mcpManifest(request.source.manifest),
    board: selectExportBoardSnapshot(request.source.boardSnapshot, request.selection),
    artifacts: prepared.map(({ artifact, assets }) => mcpArtifact(artifact, assets)),
    assetResources: prepared.flatMap(({ artifact, assets }) => mcpAssetResources(artifact, assets)),
  };
}

function mcpArtifact(artifact: ExportArtifactSource, assets: ExportArtifactSource["assets"]) {
  const binary = artifact.content instanceof Uint8Array;
  const binaryContent = binary ? artifact.content as Uint8Array : null;
  return {
    position: artifact.position,
    artifactId: artifact.artifactId,
    artifactVersionId: artifact.artifactVersionId,
    kind: artifact.kind,
    title: artifact.title,
    version: artifact.version,
    schemaVersion: artifact.schemaVersion,
    checksum: artifact.checksum,
    contentMediaType: artifact.contentMediaType,
    encoding: binary ? "base64" : "json",
    content: binaryContent ? Buffer.from(binaryContent).toString("base64") : canonicalJson(mcpJsonContent(artifact)),
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      uri: mcpAssetUri(artifact.artifactVersionId, asset.assetId),
      mimeType: asset.mediaType,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
    })),
  };
}

function mcpManifest(manifest: ExportBuildRequest["source"]["manifest"]) {
  return publicProjectReleaseManifestSchema.parse({
    ...manifest,
    artifacts: manifest.artifacts.map(({ assets: _assets, ...artifact }) => artifact),
  });
}

function mcpJsonContent(artifact: ExportArtifactSource): JsonValue {
  if (artifact.content instanceof Uint8Array) {
    throw new TerminalExportError(
      "EXPORT_MCP_JSON_CONTENT_INVALID",
      `ArtifactVersion ${artifact.artifactVersionId} has binary content in JSON mode`,
    );
  }
  if (artifact.kind === "prototype") {
    const parsed = prototypeDocumentSchema.safeParse(artifact.content);
    if (!parsed.success) {
      throw new TerminalExportError(
        "EXPORT_PROTOTYPE_IR_INVALID",
        `Prototype ${artifact.artifactVersionId} does not conform to workbench.prototype.v1`,
        { cause: parsed.error },
      );
    }
    return publicPrototypeDocumentSchema.parse({
      ...parsed.data,
      assets: parsed.data.assets.map(publicAsset),
    });
  }
  if (artifact.kind === "design_system") {
    const parsed = designSystemDocumentSchema.safeParse(artifact.content);
    if (!parsed.success) {
      throw new TerminalExportError(
        "EXPORT_DESIGN_SYSTEM_IR_INVALID",
        `Design System ${artifact.artifactVersionId} does not conform to workbench.design-system.v1`,
        { cause: parsed.error },
      );
    }
    return publicDesignSystemDocumentSchema.parse({
      ...parsed.data,
      assets: parsed.data.assets.map(publicAsset),
    });
  }
  return artifact.content;
}

function publicAsset<T extends { kind: string }>(asset: T) {
  if (!("blobId" in asset)) return asset;
  const { blobId: _blobId, ...value } = asset;
  return value;
}

function mcpAssetResources(
  artifact: ExportArtifactSource,
  assets: ExportArtifactSource["assets"],
) {
  return assets.map((asset, assetPosition) => ({
    position: artifact.position,
    assetPosition,
    artifactVersionId: artifact.artifactVersionId,
    assetId: asset.assetId,
    uri: mcpAssetUri(artifact.artifactVersionId, asset.assetId),
    mimeType: asset.mediaType,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
    encoding: "base64" as const,
    content: Buffer.from(asset.bytes).toString("base64"),
  }));
}

function validatedArtifactAssets(artifact: ExportArtifactSource) {
  const assets = sortedAssets(artifact);
  const expected = expectedArtifactAssets(artifact);
  if (assets.length !== expected.length) {
    throw new TerminalExportError(
      "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH",
      `ArtifactVersion ${artifact.artifactVersionId} asset pin count changed`,
    );
  }
  for (const [index, asset] of assets.entries()) {
    const pin = expected[index];
    if (
      !pin
      || asset.assetId !== pin.id
      || asset.kind !== pin.kind
      || asset.blobId !== pin.blobId
      || asset.mediaType !== pin.mediaType
      || asset.byteSize !== pin.byteSize
      || asset.sha256 !== pin.sha256
      || createHash("sha256").update(asset.bytes).digest("hex") !== asset.sha256
    ) {
      throw new TerminalExportError(
        "EXPORT_ARTIFACT_ASSET_PIN_MISMATCH",
        `ArtifactVersion ${artifact.artifactVersionId} asset ${asset.assetId} changed`,
      );
    }
  }
  return assets;
}

function expectedArtifactAssets(artifact: ExportArtifactSource) {
  if (artifact.kind !== "prototype" && artifact.kind !== "design_system") return [];
  if (artifact.content instanceof Uint8Array) {
    throw new TerminalExportError(
      "EXPORT_MCP_JSON_CONTENT_INVALID",
      `ArtifactVersion ${artifact.artifactVersionId} has binary content in JSON mode`,
    );
  }
  const parsed = artifact.kind === "prototype"
    ? prototypeDocumentSchema.safeParse(artifact.content)
    : designSystemDocumentSchema.safeParse(artifact.content);
  if (!parsed.success) {
    throw new TerminalExportError(
      artifact.kind === "prototype" ? "EXPORT_PROTOTYPE_IR_INVALID" : "EXPORT_DESIGN_SYSTEM_IR_INVALID",
      artifact.kind === "prototype"
        ? `Prototype ${artifact.artifactVersionId} does not conform to workbench.prototype.v1`
        : `Design System ${artifact.artifactVersionId} does not conform to workbench.design-system.v1`,
      { cause: parsed.error },
    );
  }
  return parsed.data.assets
    .filter((asset): asset is Extract<typeof asset, { kind: "image" | "font" }> => asset.kind !== "icon")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function sortedAssets(artifact: ExportArtifactSource) {
  const assets = [...artifact.assets].sort((left, right) => left.assetId.localeCompare(right.assetId, "en"));
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    throw new TerminalExportError(
      "EXPORT_ARTIFACT_ASSET_ID_DUPLICATED",
      `ArtifactVersion ${artifact.artifactVersionId} contains duplicate asset ids`,
    );
  }
  for (const asset of assets) {
    if (asset.bytes.byteLength !== asset.byteSize) {
      throw new TerminalExportError(
        "EXPORT_ASSET_IDENTITY_MISMATCH",
        `ArtifactVersion ${artifact.artifactVersionId} asset ${asset.assetId} byte size changed`,
      );
    }
  }
  return assets;
}

function mcpAssetUri(artifactVersionId: string, assetId: string) {
  return `workbench://artifact/${encodeURIComponent(artifactVersionId)}/asset/${encodeURIComponent(assetId)}`;
}

function mcpServerName(request: ExportBuildRequest) {
  const requested = request.options.serverName;
  if (requested !== undefined && (typeof requested !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(requested))) {
    throw new TerminalExportError("EXPORT_MCP_SERVER_NAME_INVALID", "MCP serverName must match ^[a-z][a-z0-9-]{0,62}$");
  }
  return typeof requested === "string" ? requested : `workbench-release-${request.source.releaseVersion}`;
}
