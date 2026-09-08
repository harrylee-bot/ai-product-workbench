import { Injectable } from "@nestjs/common";
import {
  exportCapabilitiesSchema,
  type ExternalExportAuthentication,
  type ExternalExportTarget,
  type ExportCapabilities,
  type ExportFormat,
  type JsonValue,
} from "@workbench/workbench-contracts";

const localAvailable = {
  available: true as const,
  authentication: "not_required" as const,
  reasonCode: null,
};
const externalAuthRequired = {
  available: false as const,
  authentication: "required" as const,
  reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" as const,
};

function e2eEnabledExternalTargets() {
  if (
    process.env.NODE_ENV !== "test"
    || process.env.WORKBENCH_E2E_EXTERNAL_DELIVERY_AVAILABLE !== "netlify"
  ) return new Set<string>();
  return new Set(["netlify"]);
}

@Injectable()
export class ExportCapabilitiesConfig {
  catalog(): ExportCapabilities {
    const e2eTargets = e2eEnabledExternalTargets();
    return exportCapabilitiesSchema.parse({
      formats: {
        html: localAvailable,
        react: localAvailable,
        figma: localAvailable,
        mcp: localAvailable,
        docx: localAvailable,
        pdf: localAvailable,
      },
      packaging: {
        single_file: localAvailable,
        zip: localAvailable,
      },
      external: {
        ai_studio: {
          available: false,
          authentication: "not_required",
          reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
        },
        netlify: e2eTargets.has("netlify")
          ? { available: true, authentication: "authenticated", reasonCode: null }
          : externalAuthRequired,
        lovable: externalAuthRequired,
        bolt: externalAuthRequired,
      },
    });
  }

  external(target: ExternalExportTarget): {
    available: boolean;
    authentication: ExternalExportAuthentication;
    reasonCode: string | null;
  } {
    return this.catalog().external[target];
  }

  materializeOptions(
    _format: ExportFormat,
    clientOptions: Record<string, JsonValue>,
  ): Record<string, JsonValue> {
    return { ...clientOptions };
  }
}
