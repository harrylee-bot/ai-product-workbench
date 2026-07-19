import type { CreateImportSourceRequest } from "@workbench/workbench-contracts";
import type { FrozenImport, ImportProvider } from "./source-types.js";
import { TerminalImportError } from "../errors.js";

export class ImportProviderRegistry {
  constructor(private readonly providers: readonly ImportProvider[]) {}

  async freeze(request: Exclude<CreateImportSourceRequest, { kind: "file" | "design_md" }>, signal?: AbortSignal): Promise<FrozenImport> {
    const provider = this.providers.find((candidate) => candidate.supports(request.kind));
    if (!provider) throw new TerminalImportError("IMPORT_PROVIDER_UNAVAILABLE", `No provider is configured for ${request.kind}`);
    return provider.freeze(request, signal);
  }
}
