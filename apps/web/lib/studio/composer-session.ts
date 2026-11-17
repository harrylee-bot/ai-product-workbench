"use client";
import { useEffect, useRef, useState } from "react";
import type {
  PrototypePlanInput,
  StartRunRequest,
} from "@workbench/workbench-contracts";
import type { StudioArtifactContext, StudioPlanTarget } from "./types";

export type ComposerContext =
  | { kind: "new"; key: "new"; title: string }
  | {
      kind: "input";
      key: string;
      title: string;
      target: StudioPlanTarget;
      input: PrototypePlanInput;
      operationRequest: StartRunRequest;
      version?: number;
    }
  | {
      kind: "artifact";
      key: string;
      title: string;
      artifact: StudioArtifactContext;
    };
export type ComposerDraft = {
  prompt: string;
  modelId: string;
  sourceIds: string[];
  requestedArtifactKinds: StartRunRequest["requestedArtifactKinds"];
  targetSurface: StartRunRequest["targetSurface"];
  designStyle: StartRunRequest["designStyle"];
  files: File[];
  missingFiles: {
    name: string;
    size: number;
    type: string;
    lastModified: number;
  }[];
};
type Entry = {
  context: ComposerContext;
  draft: ComposerDraft;
};
export type ComposerSession = {
  version: 1;
  activeKey: string;
  entries: Record<string, Entry>;
};
const newContext: ComposerContext = {
  kind: "new",
  key: "new",
  title: "新建计划",
};
export function newComposerEntry(context: ComposerContext, prompt = ""): Entry {
  const input = context.kind === "input" ? context.operationRequest : undefined;
  return {
    context,
    draft: {
      prompt,
      modelId: input?.modelId ?? "",
      sourceIds: input?.sourceIds ?? [],
      requestedArtifactKinds: input?.requestedArtifactKinds ?? [
        "prd",
        "prototype",
      ],
      targetSurface: input?.targetSurface ?? "web",
      designStyle: input?.designStyle ?? { kind: "automatic" },
      files: [],
      missingFiles: [],
    },
  };
}
function restoreComposerEntry(
  existing: Entry | undefined,
  context: ComposerContext,
  prompt: string,
): Entry {
  if (!existing) return newComposerEntry(context, prompt);
  if (existing.context.kind === "input" && context.kind === "input")
    return {
      ...existing,
      context,
    };
  return existing;
}
function emptySession(prompt = ""): ComposerSession {
  return {
    version: 1,
    activeKey: "new",
    entries: { new: newComposerEntry(newContext, prompt) },
  };
}

// Only authorized source references and local file metadata are persisted.
// Unuploaded file bytes stay in memory and require explicit reselection on reload.
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("workbench-studio-composer-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("sessions");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
export async function readComposerSession(
  key: string,
): Promise<ComposerSession | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("sessions", "readonly");
      const request = transaction.objectStore("sessions").get(key);
      request.onsuccess = () => {
        const result = request.result as ComposerSession | undefined;
        if (
          result &&
          (result.version !== 1 ||
            !result.entries?.[result.activeKey] ||
            !result.entries.new)
        )
          reject(new Error("本地草稿格式无法读取"));
        else resolve(result);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function writeComposerSession(
  key: string,
  session: ComposerSession,
): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("sessions", "readwrite");
      const persisted: ComposerSession = {
        ...session,
        entries: Object.fromEntries(
          Object.entries(session.entries).map(([entryKey, entry]) => [
            entryKey,
            {
              ...entry,
              draft: {
                ...entry.draft,
                files: [],
                missingFiles: [
                  ...entry.draft.missingFiles,
                  ...entry.draft.files.map(
                    ({ name, size, type, lastModified }) => ({
                      name,
                      size,
                      type,
                      lastModified,
                    }),
                  ),
                ],
              },
            },
          ]),
        ),
      };
      transaction.objectStore("sessions").put(persisted, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
const writes = new Map<string, Promise<void>>();
export async function clearStudioComposerSessions(): Promise<void> {
  await Promise.allSettled([...writes.values()]);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
function enqueueWrite(key: string, session: ComposerSession) {
  const next = (writes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeComposerSession(key, session));
  writes.set(key, next);
  void next
    .finally(() => {
      if (writes.get(key) === next) writes.delete(key);
    })
    .catch(() => {});
  return next;
}
export function useStudioComposerSession(userId: string, projectId: string) {
  const key = `${userId}:${projectId}`;
  const selection = useRef({ key, generation: 0, active: true });
  if (selection.current.key !== key)
    selection.current = { key, generation: selection.current.generation + 1, active: true };
  useEffect(() => {
    selection.current.active = true;
    return () => { selection.current.active = false; selection.current.generation++; };
  }, [key]);
  const [state, setState] = useState<{
    key: string;
    value: ComposerSession;
    ready: boolean;
    persist: boolean;
  }>({ key, value: emptySession(), ready: false, persist: false });
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    const logout = () => {
      selection.current.generation++;
      selection.current.active = false;
      setState({ key, value: emptySession(), ready: false, persist: false });
    };
    window.addEventListener("workbench:logout", logout);
    return () => window.removeEventListener("workbench:logout", logout);
  }, [key]);
  useEffect(() => {
    let active = true;
    if (!userId) return;
    void (async () => {
      try {
        await writes.get(key)?.catch(() => {});
        const saved = await readComposerSession(key);
        if (active) {
          setState({
            key,
            value: saved ?? emptySession(),
            ready: true,
            persist: true,
          });
          setStorageError("");
        }
      } catch {
        if (active) {
          setState({ key, value: emptySession(), ready: true, persist: false });
          setStorageError("本地草稿存储不可用，离开或刷新前请保留输入与附件。");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [key, userId, projectId]);
  const ready = state.ready && state.key === key;
  useEffect(() => {
    if (!ready || !state.persist) return;
    let active = true;
    void enqueueWrite(key, state.value).then(
      () => {
        if (active) setStorageError("");
      },
      () => {
        if (active)
          setStorageError(
            "草稿暂未保存到本机，文字和附件仍在当前页面；请勿刷新。",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [key, ready, state.value, state.persist]);
  const session = ready ? state.value : emptySession();
  const entry = session.entries[session.activeKey]!;
  const update = (transform: (value: ComposerSession) => ComposerSession) =>
    setState((current) =>
      current.ready && current.key === key
        ? { ...current, value: transform(current.value) }
        : current,
    );
  const updateEntry = (entryKey: string, transform: (value: Entry) => Entry) =>
    update((current) =>
      current.entries[entryKey]
        ? {
            ...current,
            entries: {
              ...current.entries,
              [entryKey]: transform(current.entries[entryKey]!),
            },
          }
        : current,
    );
  const switchTo = (
    context: ComposerContext,
    prompt = "",
    options?: { inheritPrompt: boolean; fromKey: string },
  ) => {
    if (!selection.current.active || selection.current.key !== key) return false;
    selection.current.generation++;
    update((current) =>
      options && current.activeKey !== options.fromKey ? current : {
        ...current, activeKey: context.key,
        entries: { ...current.entries, [context.key]: restoreComposerEntry(
          current.entries[context.key], context,
          options?.inheritPrompt ? current.entries[current.activeKey]!.draft.prompt : prompt,
        ) },
      },
    );
    return true;
  };
  return {
    ready,
    entry,
    entries: Object.values(session.entries),
    storageError,
    updateDraft: (transform: (draft: ComposerDraft) => ComposerDraft) =>
      updateEntry(entry.context.key, (current) => ({
        ...current,
        draft: transform(current.draft),
      })),
    switchTo,
    beginSourceSelection: () => {
      const generation = ++selection.current.generation;
      return (...args: Parameters<typeof switchTo>) => {
        if (!selection.current.active || selection.current.key !== key || selection.current.generation !== generation) return false;
        return switchTo(...args);
      };
    },
    newContext,
    bindFileSource: (entryKey: string, file: File, sourceId: string) =>
      updateEntry(entryKey, (current) => ({
        ...current,
        draft: {
          ...current.draft,
          files: current.draft.files.filter((item) => item !== file),
          sourceIds: [...new Set([...current.draft.sourceIds, sourceId])],
        },
      })),
    complete: (
      entryKey: string,
      submitted: ComposerDraft,
      keepContext = false,
    ) =>
      update((current) => {
        const original = current.entries[entryKey];
        if (!original) return current;
        const draft = {
          ...original.draft,
          prompt:
            original.draft.prompt === submitted.prompt
              ? ""
              : original.draft.prompt,
          files: original.draft.files.filter(
            (file) => !submitted.files.includes(file),
          ),
        };
        const entries = {
          ...current.entries,
          [entryKey]: { ...original, draft },
        };
        const finished =
          !keepContext &&
          entryKey !== "new" &&
          !draft.prompt &&
          !draft.files.length &&
          !draft.missingFiles.length;
        if (finished) delete entries[entryKey];
        return {
          ...current,
          entries,
          activeKey:
            finished && current.activeKey === entryKey
              ? "new"
              : current.activeKey,
        };
      }),
  };
}
