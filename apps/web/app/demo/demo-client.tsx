"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { HomeScreen } from "@/components/workbench/workbench-home-screen";
import { WorkbenchTransportProvider, type WorkbenchTransport } from "@/lib/workbench/transport";
import type { WorkbenchApiClient } from "@/lib/workbench/api";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import type { WorkbenchRunSubmission } from "@/lib/workbench/features/workbench-controller";
import type { WorkbenchModelChoice } from "@/lib/workbench/features/workbench-presenter";

const demoModelChoices: WorkbenchModelChoice[] = [{
  description: "用于本地页面演示的稳定模型",
  key: "model:demo",
  label: "Demo Model",
  modelId: "demo",
  workflow: "generate",
}];

const demoProjects = [
  {
    accent: "#7467f6",
    date: "10 Nov 2026",
    group: "示例" as const,
    id: "demo-product-workbench",
    revision: 1,
    role: "owner" as const,
    shared: false,
    title: "产品工作台可视化演示",
    variant: "landscape" as const,
  },
];

const demoPreferences = {
  etag: '"demo"',
  value: {
    createdAt: null,
    productUpdatesEmail: false,
    researchInvitations: false,
    revision: 0,
    updatedAt: null,
  },
};

const demoApi = {
  async GET(path: string) {
    if (path === "/identity/preferences") {
      return { data: demoPreferences, response: new Response(null, { status: 200 }) };
    }
    return { data: {}, response: new Response(null, { status: 200 }) };
  },
  async PUT() {
    return { data: demoPreferences, response: new Response(null, { status: 200 }) };
  },
} as unknown as WorkbenchApiClient;

const demoTransport: WorkbenchTransport = {
  api: demoApi,
  baseUrl: "demo://workbench",
};

export default function DemoPage() {
  const [prompt, setPrompt] = useState("");
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState("");
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    client.setQueryData(workbenchQueryKeys.communicationPreferences(), demoPreferences);
    return client;
  });

  const modelCatalog = useMemo(() => ({
    error: null,
    retrying: false as const,
    status: "ready" as const,
  }), []);

  async function submitPrompt(submission: WorkbenchRunSubmission): Promise<string> {
    setLastSubmittedPrompt(submission.prompt);
    toast.success("演示模式已接收需求", {
      description: "当前页面使用本地静态数据渲染，未连接生产 API。",
    });
    return "demo-project";
  }

  return (
    <WorkbenchTransportProvider transport={demoTransport}>
      <QueryClientProvider client={queryClient}>
        <div className="relative h-dvh w-full overflow-hidden bg-[#131314]">
          <HomeScreen
            accountUser={null}
            busy={false}
            designSystemCatalogFetchingNextPage={false}
            designSystemCatalogHasNextPage={false}
            designSystemCatalogItems={[]}
            designSystemCatalogStatus="ready"
            hasNextProjectPage={false}
            homeProjectTab="mine"
            loadError={null}
            loadStatus="ready"
            modelCatalog={modelCatalog}
            modelChoices={demoModelChoices}
            onArchiveProject={async () => undefined}
            onCreateExternalSource={async () => null}
            onDuplicateProject={async () => undefined}
            onLoadMoreDesignSystems={() => undefined}
            onLoadMoreProjects={() => undefined}
            onLogout={async () => undefined}
            onOpenProject={() => undefined}
            onRetryDesignSystems={() => undefined}
            onRetryModels={() => undefined}
            onRetryProjects={() => undefined}
            onSubmitPrompt={submitPrompt}
            projectPageLoading={false}
            projectSearch=""
            projects={demoProjects}
            prompt={prompt}
            setHomeProjectTab={() => undefined}
            setProjectSearch={() => undefined}
            setPrompt={setPrompt}
          />
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-[90] -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-4 py-2 text-xs text-white/70 backdrop-blur-xl">
            演示模式 · {lastSubmittedPrompt ? "已接收一条需求" : "无需数据库即可预览页面"}
          </div>
        </div>
      </QueryClientProvider>
    </WorkbenchTransportProvider>
  );
}
