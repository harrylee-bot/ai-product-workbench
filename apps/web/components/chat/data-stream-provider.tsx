"use client";

import type { DataUIPart } from "ai";
import type React from "react";
import { createContext, useContext, useMemo, useState } from "react";
import type {
  CustomUIDataTypes,
  RuntimeProcessSnapshot,
} from "@/lib/types";

export const initialRuntimeProcess: RuntimeProcessSnapshot = {
  status: "idle",
  events: [],
};

type DataStreamContextValue = {
  dataStream: DataStreamEntry[];
  setDataStream: React.Dispatch<
    React.SetStateAction<DataStreamEntry[]>
  >;
  runtimeProcess: RuntimeProcessSnapshot;
  setRuntimeProcess: React.Dispatch<
    React.SetStateAction<RuntimeProcessSnapshot>
  >;
};

export type DataStreamEntry = {
  chatId: string;
  runId?: string;
  part: DataUIPart<CustomUIDataTypes>;
};

const DataStreamContext = createContext<DataStreamContextValue | null>(null);

export function DataStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [dataStream, setDataStream] = useState<DataStreamEntry[]>(
    []
  );
  const [runtimeProcess, setRuntimeProcess] =
    useState<RuntimeProcessSnapshot>(initialRuntimeProcess);

  const value = useMemo(
    () => ({ dataStream, setDataStream, runtimeProcess, setRuntimeProcess }),
    [dataStream, runtimeProcess]
  );

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

export function useDataStream() {
  const context = useContext(DataStreamContext);
  if (!context) {
    throw new Error("useDataStream must be used within a DataStreamProvider");
  }
  return context;
}
