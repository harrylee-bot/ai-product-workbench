"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";

import {
  createWorkbenchApiClient,
  type WorkbenchApiClient,
} from "../api";
import { createDocumentReads } from "./document-reads";
import { getWorkbenchApiBaseUrl } from "../api/config";

export type WorkbenchTransport = {
  api: WorkbenchApiClient;
  baseUrl: string;
};

const WorkbenchTransportContext = createContext<WorkbenchTransport | null>(null);

export function WorkbenchTransportProvider({
  children,
  observeDocumentReads = false,
}: {
  children: ReactNode;
  observeDocumentReads?: boolean;
}) {
  const reads = useMemo(createDocumentReads, []);
  useEffect(() => {
    if (observeDocumentReads) return reads.observe();
  }, [observeDocumentReads, reads]);
  const value = useMemo<WorkbenchTransport>(() => {
    const baseUrl = getWorkbenchApiBaseUrl();
    const api = createWorkbenchApiClient({ baseUrl, fetch: reads.fetch });
    return {
      api,
      baseUrl,
    };
  }, [reads]);

  return (
    <WorkbenchTransportContext.Provider value={value}>
      {children}
    </WorkbenchTransportContext.Provider>
  );
}

export function useWorkbenchTransport(): WorkbenchTransport {
  const context = useContext(WorkbenchTransportContext);
  if (!context) throw new Error("useWorkbenchTransport must be used within WorkbenchTransportProvider");
  return context;
}
