import type { CreateImportSourceRequest } from "@workbench/workbench-contracts";
import { TerminalImportError } from "../errors.js";
import { SafeHttpClient } from "../fetch/safe-http-client.js";
import { freezeImport, type FrozenImport, type ImportProvider } from "./source-types.js";

const supportedMediaTypes = [/^text\/html$/u, /^application\/xhtml\+xml$/u, /^text\/plain$/u, /^application\/json$/u];

export class UrlImportProvider implements ImportProvider {
  constructor(
    private readonly client: SafeHttpClient,
    private readonly options: { maximumBytes: number; timeoutMs: number; maximumRedirects: number },
  ) {}

  supports(kind: CreateImportSourceRequest["kind"]): boolean {
    return kind === "url_snapshot";
  }

  async freeze(request: Extract<CreateImportSourceRequest, { kind: "url_snapshot" }>, signal?: AbortSignal): Promise<FrozenImport> {
    const response = await this.client.get(request.sourceUrl, {
      maximumBytes: this.options.maximumBytes,
      timeoutMs: this.options.timeoutMs,
      maximumRedirects: this.options.maximumRedirects,
      allowedMediaTypes: supportedMediaTypes,
      signal,
    });
    const mediaType = response.mediaType ?? "text/html";
    if (!supportedMediaTypes.some((pattern) => pattern.test(mediaType))) throw new TerminalImportError("IMPORT_MEDIA_TYPE_UNSUPPORTED", "Website sources must be text or JSON documents");
    return freezeImport({
      label: request.label ?? new URL(request.sourceUrl).hostname,
      descriptor: { kind: "url_snapshot", sourceUrl: request.sourceUrl, resolvedUrl: response.url },
      blobs: [{ path: "index.html", mediaType, bytes: response.body }],
    });
  }
}
