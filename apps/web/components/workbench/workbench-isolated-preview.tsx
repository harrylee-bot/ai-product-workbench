"use client";

import type {
  ExportPreviewTokenResponse,
  ExportSelection,
} from "@workbench/workbench-contracts";
import {
  workbenchPreviewHandshake,
  workbenchPreviewRpcChannelForCapability,
  workbenchPreviewStatusSchema,
  type WorkbenchPreviewRpcMethods,
} from "@workbench/workbench-contracts";
import {
  CallOptions,
  WindowMessenger,
  connect,
  type Connection,
} from "penpal";
import { useEffect, useRef, type IframeHTMLAttributes } from "react";

import { exportSelectionIdentityKey } from "@/lib/workbench/features/export-selection";
import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "@/lib/workbench/project-session";

export const workbenchPreviewSandbox = [
  "allow-scripts",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
].join(" ");

export const workbenchPreviewConnectionTimeoutMs = 8_000;
export const workbenchPreviewHandshakeTimeoutMs = 2_000;
export const workbenchPreviewRenewalLeadMs = 30_000;
const maximumBrowserTimerDelayMs = 2_147_000_000;
const workbenchPreviewCredentiallessProps = {
  credentialless: "",
} as IframeHTMLAttributes<HTMLIFrameElement> & { credentialless: string };

type PreviewState =
  | PreviewRuntimeState<"preparing", null>
  | PreviewRuntimeState<"loading", string>
  | PreviewRuntimeState<"ready", string>
  | PreviewRuntimeState<"error", null>;

type PreviewRuntimeState<Status extends string, Url extends string | null> = {
  status: Status;
  url: Url;
  generation: number;
  connectionGeneration: number | null;
};

export function WorkbenchIsolatedPreview({
  createPreview,
  onCapabilityChange,
  refreshKey,
  selection,
  sessionKey = "",
  title,
}: {
  createPreview: (
    selection: ExportSelection,
    signal?: AbortSignal,
  ) => Promise<ExportPreviewTokenResponse>;
  onCapabilityChange?: (capability: ExportPreviewTokenResponse | null) => void;
  refreshKey: number;
  selection: ExportSelection;
  sessionKey?: string;
  title: string;
}) {
  const session = useWorkbenchProjectSession(sessionKey);
  const [state, setState] = useWorkbenchProjectState<PreviewState>(
    session,
    () => ({ status: "preparing", url: null, generation: 0, connectionGeneration: null }),
  );
  const [renewalKey, setRenewalKey] = useWorkbenchProjectState(session, () => 0);
  const selectionKey = exportSelectionIdentityKey(selection);
  const createPreviewRef = useRef(createPreview);
  const onCapabilityChangeRef = useRef(onCapabilityChange);
  const generationRef = useWorkbenchProjectRef(session, () => 0);
  const activePreviewRef = useWorkbenchProjectRef<{
    generation: number;
    capability: ExportPreviewTokenResponse;
  } | null>(session, () => null);
  const connectionRef = useWorkbenchProjectRef<{
    generation: number;
    connection: Connection<WorkbenchPreviewRpcMethods>;
  } | null>(session, () => null);
  createPreviewRef.current = createPreview;
  onCapabilityChangeRef.current = onCapabilityChange;

  useEffect(() => {
    const abortController = new AbortController();
    const generation = ++generationRef.current;
    let current = true;
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    activePreviewRef.current = null;
    destroyPreviewConnection(connectionRef);
    setState({ status: "preparing", url: null, generation, connectionGeneration: null });
    onCapabilityChangeRef.current?.(null);

    void createPreviewRef.current(selection, abortController.signal)
      .then((capability) => {
        if (!current || abortController.signal.aborted) return;
        const validated = validatePreviewCapability(
          capability,
          configuredPreviewOrigin(),
        );
        activePreviewRef.current = { generation, capability: validated };
        setState({ status: "loading", url: validated.url, generation, connectionGeneration: null });
        renewalTimer = setTimeout(() => {
          if (!current || activePreviewRef.current?.generation !== generation) return;
          setRenewalKey((key) => key + 1);
        }, previewCapabilityRenewalDelay(validated.expiresAt));
      })
      .catch((error: unknown) => {
        if (!current || abortController.signal.aborted || isAbortError(error)) return;
        activePreviewRef.current = null;
        setState({ status: "error", url: null, generation, connectionGeneration: null });
        onCapabilityChangeRef.current?.(null);
      });

    return () => {
      current = false;
      abortController.abort();
      if (renewalTimer) clearTimeout(renewalTimer);
      if (activePreviewRef.current?.generation === generation) {
        activePreviewRef.current = null;
      }
      if (connectionRef.current?.generation === generation) {
        destroyPreviewConnection(connectionRef);
      }
      onCapabilityChangeRef.current?.(null);
    };
  }, [
    activePreviewRef,
    connectionRef,
    generationRef,
    refreshKey,
    renewalKey,
    selectionKey,
    setRenewalKey,
    setState,
  ]);

  const failPreview = (generation: number) => {
    if (activePreviewRef.current?.generation !== generation) return;
    activePreviewRef.current = null;
    if (connectionRef.current?.generation === generation) {
      destroyPreviewConnection(connectionRef);
    }
    setState({ status: "error", url: null, generation, connectionGeneration: null });
    onCapabilityChangeRef.current?.(null);
  };

  const connectPreview = (frame: HTMLIFrameElement) => {
    const active = activePreviewRef.current;
    if (!active || frame.getAttribute("src") !== active.capability.url) return;
    if (connectionRef.current?.generation === active.generation) {
      failPreview(active.generation);
      return;
    }
    destroyPreviewConnection(connectionRef);
    const remoteWindow = frame.contentWindow;
    if (!remoteWindow) {
      failPreview(active.generation);
      return;
    }

    // An iframe without allow-same-origin has the serialized origin "null".
    // Penpal therefore sends to `*`, while WindowMessenger still accepts events
    // only from this exact contentWindow. The navigation URL was checked above
    // against the configured, independent Preview origin.
    const messenger = new WindowMessenger({
      remoteWindow,
      allowedOrigins: ["*"],
    });
    const connection = connect<WorkbenchPreviewRpcMethods>({
      messenger,
      channel: workbenchPreviewRpcChannelForCapability(capabilityId(active.capability.url)),
      timeout: workbenchPreviewConnectionTimeoutMs,
    });
    connectionRef.current = { generation: active.generation, connection };
    setState((current) => current.generation === active.generation
      ? { ...current, connectionGeneration: active.generation }
      : current);

    void connection.promise
      .then((remote) => remote.handshake(
        workbenchPreviewHandshake,
        new CallOptions({ timeout: workbenchPreviewHandshakeTimeoutMs }),
      ))
      .then((value) => workbenchPreviewStatusSchema.parse(value))
      .then((status) => {
        if (
          activePreviewRef.current?.generation !== active.generation
          || connectionRef.current?.connection !== connection
        ) return;
        if (status.state === "error") {
          failPreview(active.generation);
          return;
        }
        setState({
          status: "ready",
          url: active.capability.url,
          generation: active.generation,
          connectionGeneration: active.generation,
        });
        onCapabilityChangeRef.current?.(active.capability);
      })
      .catch(() => failPreview(active.generation));
  };

  return (
    <div
      className="relative h-full w-full"
      data-isolated-preview
      data-preview-connection-generation={state.connectionGeneration ?? undefined}
      data-preview-connection-timeout-ms={workbenchPreviewConnectionTimeoutMs}
      data-preview-generation={state.generation}
      data-preview-handshake-timeout-ms={workbenchPreviewHandshakeTimeoutMs}
      data-preview-state={state.status}
    >
      {state.url && (
        <iframe
          {...workbenchPreviewCredentiallessProps}
          className="h-full w-full border-0 bg-white"
          data-preview-capability
          loading="eager"
          onError={() => {
            const active = activePreviewRef.current;
            if (active) failPreview(active.generation);
          }}
          onLoad={(event) => connectPreview(event.currentTarget)}
          referrerPolicy="no-referrer"
          sandbox={workbenchPreviewSandbox}
          src={state.url}
          title={title}
        />
      )}
      {state.status !== "ready" && (
        <div
          aria-live="polite"
          className="absolute inset-0 grid place-items-center bg-[#111827] px-[24px] text-center text-[14px] text-[#aeb3bb]"
          role="status"
        >
          {state.status === "error" ? "预览加载失败，请刷新重试" : "正在准备预览..."}
        </div>
      )}
    </div>
  );
}

function capabilityId(value: string) {
  return new URL(value).pathname.slice("/preview/".length);
}

export function validatePreviewCapabilityUrl(value: string, expectedOrigin: string) {
  const expected = parseBareOrigin(expectedOrigin);
  const url = new URL(value);
  if (
    url.origin !== expected
    || url.username
    || url.password
    || url.search
    || url.hash
    || !/^\/preview\/[^/]+$/u.test(url.pathname)
  ) {
    throw new Error("PREVIEW_CAPABILITY_URL_INVALID");
  }
  if (typeof window !== "undefined" && url.origin === window.location.origin) {
    throw new Error("PREVIEW_ORIGIN_NOT_ISOLATED");
  }
  return url.href;
}

export function validatePreviewCapability(
  capability: ExportPreviewTokenResponse,
  expectedOrigin: string,
  now = Date.now(),
): ExportPreviewTokenResponse {
  const expiresAt = Date.parse(capability.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("PREVIEW_CAPABILITY_EXPIRED");
  }
  return {
    ...capability,
    url: validatePreviewCapabilityUrl(capability.url, expectedOrigin),
  };
}

export function previewCapabilityRenewalDelay(expiresAt: string, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) {
    throw new Error("PREVIEW_CAPABILITY_EXPIRED");
  }
  return Math.min(
    maximumBrowserTimerDelayMs,
    Math.max(1_000, expiry - now - workbenchPreviewRenewalLeadMs),
  );
}

function configuredPreviewOrigin() {
  const value = process.env.NEXT_PUBLIC_WORKBENCH_PREVIEW_ORIGIN?.trim();
  if (!value) throw new Error("PREVIEW_ORIGIN_NOT_CONFIGURED");
  return value;
}

function parseBareOrigin(value: string) {
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("PREVIEW_ORIGIN_INVALID");
  }
  return url.origin;
}

function destroyPreviewConnection(
  reference: { current: { connection: Connection<WorkbenchPreviewRpcMethods> } | null },
) {
  reference.current?.connection.destroy();
  reference.current = null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
