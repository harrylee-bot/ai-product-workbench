"use client";

import {
  runtimeModelListSchema,
  type RuntimeModelList,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import { parseContract } from "../../../transport/contracts";

export class WorkbenchRuntimeModelsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listRuntimeModels(): Promise<RuntimeModelList> {
    const result = await this.api.GET("/runtime/models");
    return parseContract(runtimeModelListSchema, result.data, "list runtime models");
  }
}

export function useWorkbenchRuntimeModelsApi(): WorkbenchRuntimeModelsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchRuntimeModelsApi(api), [api]);
}
