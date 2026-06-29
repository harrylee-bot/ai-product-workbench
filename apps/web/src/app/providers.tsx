"use client";

import { CopilotKit, type ReactActivityMessageRenderer } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { useEffect, useMemo, type ReactNode } from "react";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { getApiBaseUrl } from "@/lib/api";

const workbenchActivitySchema = z.object({
  label: z.string().optional(),
  detail: z.string().optional(),
  status: z.string().optional(),
});

const workbenchActivityRenderer: ReactActivityMessageRenderer<z.infer<typeof workbenchActivitySchema>> = {
  activityType: "workbench-prd-progress",
  content: workbenchActivitySchema,
  render: ({ content }) => {
    const detail = content.detail?.trim();
    const label = content.label?.trim() || "执行中";
    return (
      <div className="my-1 inline-flex max-w-full items-center gap-2 rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1 text-xs leading-5 text-gray-600">
        <span className={["h-1.5 w-1.5 rounded-full", content.status === "failed" ? "bg-red-400" : content.status === "done" ? "bg-emerald-400" : "bg-amber-400"].join(" ")} />
        <span className="shrink-0 font-medium">{label}</span>
        {detail ? <span className="min-w-0 truncate text-gray-500">{detail}</span> : null}
      </div>
    );
  },
};

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <CopilotRuntimeProvider>{children}</CopilotRuntimeProvider>
    </AuthProvider>
  );
}

function CopilotRuntimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const runtimeUrl = useMemo(() => `${getApiBaseUrl()}/copilotkit`, []);
  const renderers = useMemo(() => [workbenchActivityRenderer], []);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const removeInspector = () => {
      document.querySelectorAll("cpk-web-inspector").forEach((element) => element.remove());
    };
    removeInspector();

    const observer = new MutationObserver(removeInspector);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);

  if (!user) return <>{children}</>;

  return (
    <CopilotKit
      runtimeUrl={runtimeUrl}
      credentials="include"
      showDevConsole={false}
      renderActivityMessages={renderers}
      onError={(event) => {
        console.error("[copilotkit]", event);
      }}
    >
      {children}
    </CopilotKit>
  );
}
