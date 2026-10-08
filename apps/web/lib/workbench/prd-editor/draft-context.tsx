"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { PrdDraftStore } from "./draft-store";

const PrdDraftContext = createContext<PrdDraftStore | null>(null);

export function WorkbenchPrdDraftProvider({ children, namespace }: { children: ReactNode; namespace?: string | null }) {
  const store = useMemo(() => {
    let storage: Storage | undefined;
    try { if (namespace && typeof window !== "undefined") storage = window.localStorage; } catch { /* Memory drafts still work. */ }
    return new PrdDraftStore(storage, namespace ? `workbench:prd-drafts:${encodeURIComponent(namespace)}` : undefined);
  }, [namespace]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!store.hasDrafts()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [store]);

  return <PrdDraftContext.Provider value={store}>{children}</PrdDraftContext.Provider>;
}

export function useWorkbenchPrdDraftStore() {
  return useContext(PrdDraftContext);
}
