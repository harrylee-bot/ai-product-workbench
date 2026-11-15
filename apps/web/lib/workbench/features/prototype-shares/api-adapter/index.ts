"use client";

import {
  prototypePublicShareSchema,
  type PrototypePublicShare,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";
import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import { parseContract, requireData, WorkbenchContractError, type ImmutableVersioned } from "../../../transport/contracts";

export class WorkbenchPrototypeSharesApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async getPublicShare(token: string): Promise<ImmutableVersioned<PrototypePublicShare>> {
    const result = await this.api.GET("/public/prototype-v2/shares/{token}", { params: { path: { token } } });
    const value = parseContract(prototypePublicShareSchema, result.data, "get public prototype share");
    const etag = result.response.headers.get("etag");
    if (!etag) throw new WorkbenchContractError("get public prototype share ETag");
    return { value, etag };
  }
}

export function useWorkbenchPrototypeSharesApi(): WorkbenchPrototypeSharesApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchPrototypeSharesApi(api), [api]);
}

export function requirePrototypeShareData(value: PrototypePublicShare | undefined): PrototypePublicShare {
  return requireData(value, "get public prototype share");
}
