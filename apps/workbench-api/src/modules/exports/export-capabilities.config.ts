import { Injectable } from "@nestjs/common";
import {
  exportCapabilitiesSchema,
  type ExportCapabilities,
} from "@workbench/workbench-contracts";

const localAvailable = {
  available: true as const,
  reasonCode: null,
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
        docx: localAvailable,
        pdf: localAvailable,
      },
      packaging: {
        single_file: localAvailable,
        zip: localAvailable,
      },
    });
  }


}
