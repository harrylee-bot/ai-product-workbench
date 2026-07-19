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

@Injectable()
export class ExportCapabilitiesConfig {
  catalog(): ExportCapabilities {
    return exportCapabilitiesSchema.parse({
      formats: {
        html: localAvailable,
        react: localAvailable,
        figma: localAvailable,
        mcp: localAvailable,
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
        netlify: externalAuthRequired,
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
