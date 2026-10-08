// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Layout from "./layout";

const mocks = vi.hoisted(() => ({ replace: vi.fn(), loading: false, user: null as { id: string } | null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/projects/project-1",
  useSearchParams: () => new URLSearchParams("node=prd-1&view=document"),
}));
vi.mock("@/lib/auth/workbench-auth", () => ({ useWorkbenchAuth: () => mocks }));
vi.mock("@/components/workbench/workbench-runtime", () => ({ WorkbenchRuntimeProvider: () => null }));
vi.mock("@/lib/workbench/query", () => ({ WorkbenchQueryProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/workbench/transport", () => ({ WorkbenchTransportProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null }));
afterEach(() => { cleanup(); mocks.replace.mockReset(); });

describe("expired workbench sessions", () => {
  it("retains the complete project URL as the login return path", async () => {
    render(<Layout><div>项目</div></Layout>);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/projects/project-1?node=prd-1&view=document")}`,
    ));
  });
});
