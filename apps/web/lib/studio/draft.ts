"use client";
import { useEffect, useState } from "react";
export function useStudioDraft(userId: string, projectId: string) {
  const key = `workbench:studio:${userId}:${projectId}:prompt`;
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, draft);
    } catch {
      /* Storage can be disabled; keep state in memory. */
    }
  }, [draft, key]);
  return [draft, setDraft] as const;
}
