"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

import {
  createWorkbenchApiClient,
  type WorkbenchApiClient,
} from "../api";
import { getWorkbenchApiBaseUrl } from "../api/config";

export type WorkbenchTransport = {
  api: WorkbenchApiClient;
  baseUrl: string;
};

const WorkbenchTransportContext = createContext<WorkbenchTransport | null>(null);

export function WorkbenchTransportProvider({
  children,
}: {
  children: ReactNode;
}) {
  const value = useMemo<WorkbenchTransport>(() => {
    const baseUrl = getWorkbenchApiBaseUrl();
    const api = createWorkbenchApiClient({ baseUrl });
    return {
      api,
      baseUrl,
    };
  }, []);

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

export function useOptionalWorkbenchTransport(): WorkbenchTransport | null {
  return useContext(WorkbenchTransportContext);
}
