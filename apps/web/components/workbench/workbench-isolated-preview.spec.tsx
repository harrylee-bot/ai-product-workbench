// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type {
  ExportPreviewTokenResponse,
  ExportSelection,
} from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const penpal = vi.hoisted(() => ({
  callOptions: [] as Array<{ timeout?: number }>,
  connect: vi.fn(),
  connections: [] as Array<{
    destroy: ReturnType<typeof vi.fn>;
    handshake: ReturnType<typeof vi.fn>;
  }>,
  messengers: [] as Array<{ remoteWindow: Window; allowedOrigins: string[] }>,
}));

vi.mock("penpal", () => ({
  CallOptions: class MockCallOptions {
    constructor(options: { timeout?: number }) {
      penpal.callOptions.push(options);
      Object.assign(this, options);
    }
  },
  WindowMessenger: class MockWindowMessenger {
    constructor(options: { remoteWindow: Window; allowedOrigins: string[] }) {
      penpal.messengers.push(options);
    }
  },
  connect: penpal.connect,
}));

import {
  WorkbenchIsolatedPreview,
  previewCapabilityRenewalDelay,
  validatePreviewCapability,
  validatePreviewCapabilityUrl,
  workbenchPreviewConnectionTimeoutMs,
  workbenchPreviewHandshakeTimeoutMs,
  workbenchPreviewRenewalLeadMs,
  workbenchPreviewSandbox,
} from "./workbench-isolated-preview";

const previewOrigin = "https://preview.example.test";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_WORKBENCH_PREVIEW_ORIGIN", previewOrigin);
  penpal.callOptions.length = 0;
  penpal.connections.length = 0;
  penpal.messengers.length = 0;
  penpal.connect.mockReset();
  penpal.connect.mockImplementation(() => createRpcConnection().connection);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Workbench isolated Preview", () => {
  it("loads a capability in an opaque sandbox and becomes ready only after the v1 handshake", async () => {
    const createPreview = vi.fn(async () => capability("first"));
    const onCapabilityChange = vi.fn();
    render(
      <WorkbenchIsolatedPreview
        createPreview={createPreview}
        onCapabilityChange={onCapabilityChange}
        refreshKey={0}
        selection={selection("artifact-1", "version-1", "screen-home")}
        title="项目预览"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("正在准备预览...");
    const frame = await screen.findByTitle("项目预览");
    expect(frame.getAttribute("src")).toBe(`${previewOrigin}/preview/first`);
    expect(frame.getAttribute("sandbox")).toBe(workbenchPreviewSandbox);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.hasAttribute("credentialless")).toBe(true);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(onCapabilityChange).toHaveBeenLastCalledWith(null);

    fireEvent.load(frame);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(onCapabilityChange).toHaveBeenLastCalledWith(capability("first"));
    const rpc = penpal.connections[0]!;
    expect(rpc.handshake).toHaveBeenCalledWith(
      { protocol: "workbench.preview", version: 1 },
      expect.objectContaining({ timeout: workbenchPreviewHandshakeTimeoutMs }),
    );
    expect(penpal.connect).toHaveBeenCalledWith(expect.objectContaining({
      channel: "workbench.preview.v1:first",
      timeout: workbenchPreviewConnectionTimeoutMs,
    }));
    expect(penpal.messengers[0]).toEqual({
      remoteWindow: (frame as HTMLIFrameElement).contentWindow,
      allowedOrigins: ["*"],
    });
  });

  it("does not treat iframe load as ready while the RPC handshake is pending", async () => {
    const pending = deferred<unknown>();
    const rpc = createRpcConnection(() => pending.promise);
    penpal.connect.mockReturnValueOnce(rpc.connection);
    renderPreview({ createPreview: async () => capability("pending") });

    fireEvent.load(await screen.findByTitle("项目预览"));
    expect(screen.getByRole("status").textContent).toBe("正在准备预览...");

    pending.resolve(readyStatus());
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("fails closed instead of reconnecting after the loaded frame navigates", async () => {
    renderPreview({ createPreview: async () => capability("navigation") });
    const frame = await screen.findByTitle("项目预览");
    fireEvent.load(frame);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const connection = penpal.connections[0]!;

    fireEvent.load(frame);
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("预览加载失败，请刷新重试"));
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(penpal.connect).toHaveBeenCalledOnce();
  });

  it("fails closed for a rejected connection, runtime error, or malformed status", async () => {
    const cases: Array<() => ReturnType<typeof createRpcConnection>["connection"]> = [
      () => ({
        promise: Promise.resolve().then(() => {
          throw new Error("timeout");
        }),
        destroy: vi.fn(),
      }),
      () => createRpcConnection(async () => ({
        protocol: "workbench.preview",
        version: 1,
        state: "error",
        errorCode: "PREVIEW_RUNTIME_ERROR",
      })).connection,
      () => createRpcConnection(async () => ({ state: "ready" })).connection,
    ];

    for (const [index, createConnection] of cases.entries()) {
      cleanup();
      penpal.connect.mockReset().mockImplementationOnce(createConnection);
      renderPreview({ createPreview: async () => capability(`failure-${index}`) });
      fireEvent.load(await screen.findByTitle("项目预览"));
      await waitFor(() => expect(screen.getByRole("status").textContent)
        .toBe("预览加载失败，请刷新重试"));
      expect(screen.queryByTitle("项目预览")).toBeNull();
    }
  });

  it("rejects an unconfigured, same-origin, or unexpected capability origin before rendering", async () => {
    expect(() => validatePreviewCapabilityUrl(
      "https://other.example.test/preview/token",
      previewOrigin,
    )).toThrow("PREVIEW_CAPABILITY_URL_INVALID");
    expect(() => validatePreviewCapabilityUrl(
      `${window.location.origin}/preview/token`,
      window.location.origin,
    )).toThrow("PREVIEW_ORIGIN_NOT_ISOLATED");

    vi.stubEnv("NEXT_PUBLIC_WORKBENCH_PREVIEW_ORIGIN", "");
    renderPreview({ createPreview: async () => capability("unconfigured") });
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("预览加载失败，请刷新重试"));
    expect(screen.queryByTitle("项目预览")).toBeNull();
    expect(penpal.connect).not.toHaveBeenCalled();
  });

  it("rejects expired capabilities and schedules renewal before a valid expiry", () => {
    const now = Date.parse("2026-07-18T00:00:00.000Z");
    expect(() => validatePreviewCapability({
      url: `${previewOrigin}/preview/expired`,
      expiresAt: "2026-07-17T23:59:59.000Z",
    }, previewOrigin, now)).toThrow("PREVIEW_CAPABILITY_EXPIRED");
    expect(previewCapabilityRenewalDelay(
      "2026-07-18T00:10:00.000Z",
      now,
    )).toBe(10 * 60_000 - workbenchPreviewRenewalLeadMs);
  });

  it("aborts the previous capability request and ignores its late result when the selection changes", async () => {
    const first = deferred<ExportPreviewTokenResponse>();
    const second = deferred<ExportPreviewTokenResponse>();
    const signals: AbortSignal[] = [];
    const createPreview = vi.fn((_: ExportSelection, signal?: AbortSignal) => {
      signals.push(signal!);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const rendered = render(
      <WorkbenchIsolatedPreview
        createPreview={createPreview}
        refreshKey={0}
        selection={selection("artifact-1", "version-1", "screen-home")}
        title="项目预览"
      />,
    );

    rendered.rerender(
      <WorkbenchIsolatedPreview
        createPreview={createPreview}
        refreshKey={0}
        selection={selection("artifact-1", "version-1", "screen-success")}
        title="项目预览"
      />,
    );
    expect(signals[0]?.aborted).toBe(true);

    first.resolve(capability("stale"));
    second.resolve(capability("current"));
    const frame = await screen.findByTitle("项目预览");
    expect(frame.getAttribute("src")).toBe(`${previewOrigin}/preview/current`);
    expect(frame.getAttribute("src")).not.toBe(`${previewOrigin}/preview/stale`);
  });

  it("destroys the active connection before refresh and on unmount", async () => {
    const createPreview = vi.fn()
      .mockResolvedValueOnce(capability("first"))
      .mockResolvedValueOnce(capability("refreshed"));
    const props = {
      createPreview,
      selection: selection("artifact-1", "version-1"),
      title: "项目预览",
    };
    const rendered = render(<WorkbenchIsolatedPreview {...props} refreshKey={0} />);
    fireEvent.load(await screen.findByTitle("项目预览"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const firstConnection = penpal.connections[0]!;

    rendered.rerender(<WorkbenchIsolatedPreview {...props} refreshKey={1} />);
    expect(firstConnection.destroy).toHaveBeenCalledOnce();
    const refreshed = await screen.findByTitle("项目预览");
    await waitFor(() => expect(refreshed.getAttribute("src"))
      .toBe(`${previewOrigin}/preview/refreshed`));
    fireEvent.load(refreshed);
    await waitFor(() => expect(penpal.connections).toHaveLength(2));

    rendered.unmount();
    expect(penpal.connections[1]!.destroy).toHaveBeenCalledOnce();
  });

  it("does not restart the capability request when only the callback reference changes", async () => {
    const request = vi.fn(async (_selection: ExportSelection, _signal?: AbortSignal) => capability("stable"));
    const props = {
      refreshKey: 0,
      selection: selection("artifact-1", "version-1"),
      title: "项目预览",
    };
    const rendered = render(
      <WorkbenchIsolatedPreview {...props} createPreview={(value, signal) => request(value, signal)} />,
    );
    await screen.findByTitle("项目预览");

    rendered.rerender(
      <WorkbenchIsolatedPreview {...props} createPreview={(value, signal) => request(value, signal)} />,
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });

  it("restarts the same selection for a new Project session and ignores the old capability", async () => {
    const first = deferred<ExportPreviewTokenResponse>();
    let firstSignal: AbortSignal | undefined;
    const createPreview = vi.fn()
      .mockImplementationOnce((_selection: ExportSelection, signal?: AbortSignal) => {
        firstSignal = signal;
        return first.promise;
      })
      .mockResolvedValueOnce(capability("project-two"));
    const props = {
      createPreview,
      refreshKey: 0,
      selection: selection("artifact-shared", "version-shared"),
      title: "项目预览",
    };
    const rendered = render(<WorkbenchIsolatedPreview {...props} sessionKey="project-1" />);
    const root = rendered.container.querySelector("[data-isolated-preview]");
    await waitFor(() => expect(createPreview).toHaveBeenCalledTimes(1));

    rendered.rerender(<WorkbenchIsolatedPreview {...props} sessionKey="project-2" />);
    expect(rendered.container.querySelector("[data-isolated-preview]")).toBe(root);
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("正在准备预览...");

    const frame = await screen.findByTitle("项目预览");
    expect(frame.getAttribute("src")).toBe(`${previewOrigin}/preview/project-two`);
    first.resolve(capability("project-one-late"));
    await first.promise;
    expect(frame.getAttribute("src")).toBe(`${previewOrigin}/preview/project-two`);
  });

  it("does not restart a capability request when the same Board-node set is reordered", async () => {
    const createPreview = vi.fn(async () => capability("board-selection"));
    const rendered = render(
      <WorkbenchIsolatedPreview
        createPreview={createPreview}
        refreshKey={0}
        selection={{ kind: "board_nodes", nodeIds: ["node-b", "node-a"] }}
        title="多选预览"
      />,
    );
    await screen.findByTitle("多选预览");

    rendered.rerender(
      <WorkbenchIsolatedPreview
        createPreview={createPreview}
        refreshKey={0}
        selection={{ kind: "board_nodes", nodeIds: ["node-a", "node-b"] }}
        title="多选预览"
      />,
    );

    await waitFor(() => expect(createPreview).toHaveBeenCalledTimes(1));
  });

  it("shows a recoverable failure when capability creation fails", async () => {
    renderPreview({
      createPreview: async () => {
        throw new Error("export failed");
      },
    });

    expect((await screen.findByRole("status")).textContent)
      .toBe("预览加载失败，请刷新重试");
    expect(screen.queryByTitle("项目预览")).toBeNull();
  });
});

function renderPreview({
  createPreview,
}: {
  createPreview: (selection: ExportSelection, signal?: AbortSignal) => Promise<ExportPreviewTokenResponse>;
}) {
  return render(
    <WorkbenchIsolatedPreview
      createPreview={createPreview}
      refreshKey={0}
      selection={selection("artifact-1", "version-1")}
      title="项目预览"
    />,
  );
}

function createRpcConnection(
  handshakeImplementation: () => unknown | Promise<unknown> = async () => readyStatus(),
) {
  const handshake = vi.fn(handshakeImplementation);
  const destroy = vi.fn();
  const connection = { promise: Promise.resolve({ handshake }), destroy };
  penpal.connections.push({ destroy, handshake });
  return { connection, destroy, handshake };
}

function readyStatus() {
  return {
    protocol: "workbench.preview",
    version: 1,
    state: "ready",
    errorCode: null,
  } as const;
}

function selection(artifactId: string, artifactVersionId: string, screenId?: string): ExportSelection {
  return {
    kind: "artifact",
    artifactId,
    artifactVersionId,
    ...(screenId ? { screenId } : {}),
  };
}

function capability(token: string): ExportPreviewTokenResponse {
  return {
    url: `${previewOrigin}/preview/${token}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
