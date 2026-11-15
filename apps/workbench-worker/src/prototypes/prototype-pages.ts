import { type PrototypePage } from "@workbench/workbench-contracts";
import { renderPrototypeDocumentPages, type ExportBinaryAsset } from "@workbench/workbench-export-core";

/** Per-page DOM is persisted once. The Build Worker freezes the shared runtime
 * from the immutable source document instead of copying it into every page. */
export function prototypeDocumentToPages(value: unknown, assets: ExportBinaryAsset[] = []): PrototypePage[] {
  return renderPrototypeDocumentPages(value, assets);
}
