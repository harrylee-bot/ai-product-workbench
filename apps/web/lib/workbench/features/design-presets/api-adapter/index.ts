"use client";

import {
  designPresetCatalogSchema,
  type DesignPresetCatalog,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import { parseContract } from "../../../transport/contracts";

export class WorkbenchDesignPresetsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listDesignPresets(): Promise<DesignPresetCatalog> {
    const result = await this.api.GET("/design-presets");
    return parseContract(
      designPresetCatalogSchema,
      result.data,
      "list Design preset catalog",
    );
  }
}

export function useWorkbenchDesignPresetsApi(): WorkbenchDesignPresetsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchDesignPresetsApi(api), [api]);
}
