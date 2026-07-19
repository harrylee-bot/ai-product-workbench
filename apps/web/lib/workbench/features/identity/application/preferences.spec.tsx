// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "../../../api/problem-details";
import { workbenchQueryKeys } from "../../../query/keys";
import {
  useUpdateWorkbenchCommunicationPreferences,
  useWorkbenchCommunicationPreferences,
} from "./index";
import { WorkbenchVersionRequiredError } from "../../../transport/contracts";

const mocks = vi.hoisted(() => ({
  getCommunicationPreferences: vi.fn(),
  updateCommunicationPreferences: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchIdentityApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("communication preferences hooks", () => {
  it("loads revision zero, writes with its ETag, and replaces the exact cache entry", async () => {
    const initial = versioned(false, false, 0, '"0"');
    const saved = versioned(true, false, 1, '"1"');
    mocks.getCommunicationPreferences.mockResolvedValue(initial);
    mocks.updateCommunicationPreferences.mockResolvedValue(saved);
    const queryClient = client();
    const rendered = renderHook(() => ({
      query: useWorkbenchCommunicationPreferences(),
      mutation: useUpdateWorkbenchCommunicationPreferences(),
    }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(rendered.result.current.query.data).toEqual(initial));
    await act(() => rendered.result.current.mutation.mutateAsync({
      request: { productUpdatesEmail: true, researchInvitations: false },
    }));

    expect(mocks.updateCommunicationPreferences).toHaveBeenCalledWith(
      { productUpdatesEmail: true, researchInvitations: false },
      '"0"',
    );
    expect(queryClient.getQueryData(workbenchQueryKeys.communicationPreferences()))
      .toEqual(saved);
    rendered.unmount();
    queryClient.clear();
  });

  it("refetches after a 412 and never guesses a missing revision", async () => {
    const queryClient = client();
    const refreshed = versioned(false, true, 2, '"2"');
    queryClient.setQueryData(
      workbenchQueryKeys.communicationPreferences(),
      versioned(false, false, 1, '"1"'),
    );
    mocks.getCommunicationPreferences.mockResolvedValue(refreshed);
    mocks.updateCommunicationPreferences.mockRejectedValue(new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_MISMATCH",
    }));
    const rendered = renderHook(() => ({
      query: useWorkbenchCommunicationPreferences(),
      mutation: useUpdateWorkbenchCommunicationPreferences(),
    }), { wrapper: wrapper(queryClient) });

    await expect(rendered.result.current.mutation.mutateAsync({
      request: { productUpdatesEmail: true, researchInvitations: true },
    })).rejects.toMatchObject({ status: 412 });
    await waitFor(() => expect(mocks.getCommunicationPreferences).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(workbenchQueryKeys.communicationPreferences()))
      .toEqual(refreshed);

    rendered.unmount();
    queryClient.clear();
  });

  it("never guesses a missing revision", async () => {
    const queryClient = client();
    const rendered = renderHook(
      () => useUpdateWorkbenchCommunicationPreferences(),
      { wrapper: wrapper(queryClient) },
    );

    await expect(rendered.result.current.mutateAsync({
      request: { productUpdatesEmail: false, researchInvitations: false },
    })).rejects.toBeInstanceOf(WorkbenchVersionRequiredError);
    expect(mocks.updateCommunicationPreferences).not.toHaveBeenCalled();
    rendered.unmount();
    queryClient.clear();
  });
});

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function versioned(
  productUpdatesEmail: boolean,
  researchInvitations: boolean,
  revision: number,
  etag: string,
) {
  return {
    value: {
      productUpdatesEmail,
      researchInvitations,
      revision,
      createdAt: revision === 0 ? null : "2026-07-14T08:30:00.000Z",
      updatedAt: revision === 0 ? null : "2026-07-14T08:30:00.000Z",
    },
    etag,
  };
}
