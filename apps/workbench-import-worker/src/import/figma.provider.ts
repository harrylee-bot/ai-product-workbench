import type { CreateImportSourceRequest } from "@workbench/workbench-contracts";
import { TerminalImportError } from "../errors.js";
import { SafeHttpClient } from "../fetch/safe-http-client.js";
import { freezeImport, type FrozenImport, type ImportProvider } from "./source-types.js";

export class FigmaImportProvider implements ImportProvider {
  constructor(
    private readonly client: SafeHttpClient,
    private readonly options: { token?: string; maximumBytes: number; timeoutMs: number; maximumRedirects: number },
  ) {}

  supports(kind: CreateImportSourceRequest["kind"]): boolean {
    return kind === "figma_snapshot";
  }

  async freeze(request: Extract<CreateImportSourceRequest, { kind: "figma_snapshot" }>, signal?: AbortSignal): Promise<FrozenImport> {
    if (!this.options.token) throw new TerminalImportError("FIGMA_AUTH_REQUIRED", "Figma import requires a configured access token");
    const headers = { "x-figma-token": this.options.token, accept: "application/json" };
    const get = (path: string, maximumBytes = this.options.maximumBytes) => this.client.get(`https://api.figma.com${path}`, {
      maximumBytes,
      timeoutMs: this.options.timeoutMs,
      maximumRedirects: this.options.maximumRedirects,
      allowedHosts: ["api.figma.com"],
      allowedMediaTypes: [/^application\/json$/u],
      headers,
      signal,
    });
    let versionId = request.versionId;
    if (!versionId) {
      const versions = await get(`/v1/files/${encodeURIComponent(request.fileKey)}/versions`, 2 * 1024 * 1024);
      const parsed = parseJson(versions.body, "Figma versions response");
      const first = Array.isArray(parsed.versions) ? parsed.versions[0] : null;
      if (!first || typeof first.id !== "string") throw new TerminalImportError("FIGMA_VERSION_MISSING", "Figma did not return a pinnable file version");
      versionId = first.id;
    }
    const pinnedVersion = versionId;
    if (!pinnedVersion) throw new TerminalImportError("FIGMA_VERSION_MISSING", "Figma did not return a pinnable file version");
    const file = await get(`/v1/files/${encodeURIComponent(request.fileKey)}?version=${encodeURIComponent(pinnedVersion)}`);
    parseJson(file.body, "Figma file response");
    return freezeImport({
      label: request.label ?? `Figma ${request.fileKey}@${pinnedVersion}`,
      descriptor: { kind: "figma_snapshot", fileKey: request.fileKey, versionId: pinnedVersion },
      blobs: [{ path: "figma.json", mediaType: "application/json", bytes: file.body }],
    });
  }
}

function parseJson(bytes: Buffer, label: string) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object") throw new Error("object required");
    return value as Record<string, any>;
  } catch (error) {
    throw new TerminalImportError("FIGMA_RESPONSE_INVALID", `${label} was invalid`, { cause: error });
  }
}
