"use client";
import { useEffect, useRef, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { useWorkbenchProjectsApi } from "./api";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { WorkbenchContractError } from "@/lib/workbench/transport/contracts";

function belongsToProject(query: Query, projectId: string) {
  if (query.queryKey.includes(projectId)) return true;
  const data = query.state.data as {
    projectId?: string;
    value?: { projectId?: string; project?: { id?: string } };
  } | undefined;
  return data?.projectId === projectId || data?.value?.projectId === projectId || data?.value?.project?.id === projectId;
}

// A definite authorization failure unmounts private views before authoritative
// access is checked again. Ordinary network errors preserve offline drafts/UI.
export function useStudioProjectAccess(projectId: string) {
  const client = useQueryClient();
  const api = useWorkbenchProjectsApi();
  const [state, setState] = useState({ blocked: true, checking: true, error: "", generation: 0 });
  const lifecycle = useRef({ active: true, checking: false, generation: 0 });
  const checkedFailures = useRef(new Set<string>());
  const verify = async (failureKey?: string) => {
    if (!lifecycle.current.active || lifecycle.current.checking) return;
    // Never swallow a new denial. A resource that still denies access after a
    // successful project recheck remains blocked until an explicit retry, so
    // remounting its query cannot create a verification loop.
    const repeated = !!failureKey && checkedFailures.current.has(failureKey);
    if (failureKey) checkedFailures.current.add(failureKey);
    lifecycle.current.checking = true;
    const generation = ++lifecycle.current.generation;
    const current = () => lifecycle.current.active && lifecycle.current.generation === generation;
    setState(previous => ({ blocked: true, checking: true, error: "", generation: previous.generation + 1 }));
    const predicate = (query: Query) => belongsToProject(query, projectId);
    await client.cancelQueries({ predicate });
    client.removeQueries({ predicate });
    try {
      const bootstrap = await api.getProjectBootstrap(projectId);
      if (!current()) return;
      if (bootstrap.value.project.id !== projectId) throw new WorkbenchContractError("verify project access");
      if (repeated) {
        setState(previous => ({ ...previous, blocked: true, checking: false, error: "项目中的资源仍拒绝访问。请核对权限后重新核验，未发送的草稿已保留。" }));
        return;
      }
      client.setQueryData(workbenchQueryKeys.bootstrap(projectId), bootstrap);
      setState(previous => ({ ...previous, blocked: false, checking: false, error: "" }));
    } catch (error) {
      if (!current()) return;
      setState(previous => ({ ...previous, blocked: true, checking: false,
        error: isWorkbenchApiError(error) && [401, 403, 404].includes(error.status)
          ? "项目访问权限已失效。请重新登录或联系项目所有者。"
          : "暂时无法核验项目权限，请重试。未发送的草稿仍按账户和项目保留。",
      }));
    } finally {
      if (current()) lifecycle.current.checking = false;
    }
  };
  const verifyRef = useRef(verify);
  verifyRef.current = verify;
  useEffect(() => {
    lifecycle.current.active = true;
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated") return;
      const failureKey = `query:${event.query.queryHash}`;
      if (event.action.type === "success") checkedFailures.current.delete(failureKey);
      if (event.action.type !== "error") return;
      const error = event.query.state.error;
      const bootstrapKey = workbenchQueryKeys.bootstraps(projectId);
      const isBootstrap = bootstrapKey.every((part, index) => event.query.queryKey[index] === part);
      if (belongsToProject(event.query, projectId) && isWorkbenchApiError(error) && ([401, 403].includes(error.status) || error.status === 404 && isBootstrap)) {
        void verifyRef.current(failureKey);
      }
    });
    const denied = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; status: number }>).detail;
      const projectPath = `/api/v1/projects/${encodeURIComponent(projectId)}`;
      const failureKey = `http:${detail?.path}`;
      if (detail?.status === 401 || detail?.status === 403 && (detail.path === projectPath || detail.path.startsWith(projectPath + "/")) || detail?.status === 404 && (detail.path === projectPath || detail.path === projectPath + "/bootstrap")) {
        void verifyRef.current(failureKey);
      }
    };
    window.addEventListener("workbench:access-denied", denied);
    void verifyRef.current();
    return () => {
      lifecycle.current.active = false;
      lifecycle.current.checking = false;
      lifecycle.current.generation++;
      unsubscribe(); window.removeEventListener("workbench:access-denied", denied);
    };
  }, [client, projectId]);
  return { ...state, verify: () => { checkedFailures.current.clear(); return verify(); } };
}
