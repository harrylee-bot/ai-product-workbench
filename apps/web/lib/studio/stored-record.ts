"use client";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";

export function studioRecordKey(
  userId: string | undefined,
  projectId: string,
  ...scope: string[]
) {
  return userId
    ? `workbench:studio:${[userId, projectId, ...scope].map(encodeURIComponent).join(":")}`
    : null;
}

export function useStudioStoredRecord<T>(
  key: string | null,
  schema: z.ZodType<T>,
) {
  const [state, setState] = useState<{ key: string | null; value: T | null }>({
    key: null,
    value: null,
  });
  const [error, setError] = useState("");
  const enabled = useRef(true);
  const currentKey = useRef({ key, generation: 0 });
  if (currentKey.current.key !== key)
    currentKey.current = { key, generation: currentKey.current.generation + 1 };
  const generation = currentKey.current.generation;
  const mounted = useRef(true);
  const current = () =>
    mounted.current &&
    enabled.current &&
    !!key &&
    currentKey.current.key === key &&
    currentKey.current.generation === generation;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    enabled.current = true;
    setError("");
    if (!key) {
      setState({ key, value: null });
      return;
    }
    try {
      const stored = sessionStorage.getItem(key);
      setState({
        key,
        value: stored ? schema.parse(JSON.parse(stored)) : null,
      });
    } catch {
      setState({ key, value: null });
      setError("本地编辑记录无法恢复，请保留原页面并重新读取。");
    }
  }, [key, schema]);
  useEffect(() => {
    const logout = () => {
      enabled.current = false;
      currentKey.current.generation++;
      setState({ key: null, value: null });
      setError("");
      try {
        for (const item of Object.keys(sessionStorage)) {
          if (item.startsWith("workbench:studio:"))
            sessionStorage.removeItem(item);
        }
      } catch {
        /* Storage can be disabled; logout still invalidates in-memory state. */
      }
    };
    window.addEventListener("workbench:logout", logout);
    return () => window.removeEventListener("workbench:logout", logout);
  }, []);
  const save = (value: T) => {
    if (!key || !current()) return false;
    setState({ key, value });
    try {
      sessionStorage.setItem(key, JSON.stringify(schema.parse(value)));
      setError("");
      return true;
    } catch {
      setError("浏览器无法保存本地编辑记录，刷新页面会丢失尚未保存的内容。");
      return false;
    }
  };
  const clear = () => {
    if (!key || !current()) return;
    setState({ key, value: null });
    try {
      sessionStorage.removeItem(key);
      setError("");
    } catch {
      setError("本地记录未能清除，请避免重复提交。");
    }
  };
  return {
    ready: !!key && state.key === key,
    value: state.key === key ? state.value : null,
    save,
    clear,
    error,
    isCurrent: current,
  };
}
