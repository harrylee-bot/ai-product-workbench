// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Suspense, startTransition, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "./project-session";

afterEach(cleanup);

describe("Workbench Project session", () => {
  it("presents clean state and refs in the Project-switch render without remounting the root", () => {
    const rendered = render(<SessionHarness projectId="project-1" />);
    const root = rendered.getByTestId("project-root");

    fireEvent.click(rendered.getByRole("button", { name: "dirty" }));
    expect(root.getAttribute("data-state")).toBe("dirty");
    expect(root.getAttribute("data-ref")).toBe("dirty-ref");

    rendered.rerender(<SessionHarness projectId="project-2" />);

    expect(rendered.getByTestId("project-root")).toBe(root);
    expect(root.getAttribute("data-state")).toBe("clean");
    expect(root.getAttribute("data-ref")).toBe("clean-ref");
    expect(root.getAttribute("data-generation")).toBe("2");
  });

  it("drops a previous Project generation's deferred busy, error, and navigation writes", async () => {
    const operation = deferred<string>();
    const onNavigate = vi.fn();
    const rendered = render(
      <DeferredHarness onNavigate={onNavigate} operation={operation.promise} projectId="project-1" />,
    );

    fireEvent.click(rendered.getByRole("button", { name: "run" }));
    expect(rendered.getByTestId("project-root").getAttribute("data-busy")).toBe("true");

    rendered.rerender(
      <DeferredHarness onNavigate={onNavigate} operation={operation.promise} projectId="project-2" />,
    );
    const root = rendered.getByTestId("project-root");
    expect(root.getAttribute("data-busy")).toBe("false");
    expect(root.getAttribute("data-error")).toBe("");

    await act(async () => {
      operation.reject(new Error("late project-1 failure"));
      await operation.promise.catch(() => undefined);
    });

    expect(root.getAttribute("data-busy")).toBe("false");
    expect(root.getAttribute("data-error")).toBe("");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps the committed Project session intact when a speculative switch suspends and is superseded", async () => {
    const operation = deferred<string>();
    const rendered = render(<SpeculativeProjectHarness operation={operation.promise} />);
    const root = rendered.getByTestId("project-root");

    fireEvent.click(rendered.getByRole("button", { name: "dirty" }));
    fireEvent.click(rendered.getByRole("button", { name: "run" }));
    expect(root.getAttribute("data-state")).toBe("dirty");
    expect(root.getAttribute("data-ref")).toBe("dirty-ref");

    fireEvent.click(rendered.getByRole("button", { name: "speculate" }));
    expect(rendered.getByTestId("project-root")).toBe(root);
    fireEvent.click(rendered.getByRole("button", { name: "rerender committed" }));

    expect(rendered.getByTestId("project-root")).toBe(root);
    expect(root.getAttribute("data-state")).toBe("dirty");
    expect(root.getAttribute("data-ref")).toBe("dirty-ref");

    await act(async () => {
      operation.resolve("completed");
      await operation.promise;
    });
    expect(root.getAttribute("data-state")).toBe("completed");
    expect(root.getAttribute("data-ref")).toBe("completed-ref");
  });
});

function SessionHarness({ projectId }: { projectId: string }) {
  const rootRenderCount = useRef(0);
  rootRenderCount.current += 1;
  const session = useWorkbenchProjectSession(projectId);
  const [state, setState] = useWorkbenchProjectState(session, () => "clean");
  const scopedRef = useWorkbenchProjectRef(session, () => "clean-ref");

  return (
    <section
      data-generation={session.generation}
      data-ref={scopedRef.current}
      data-render-count={rootRenderCount.current}
      data-state={state}
      data-testid="project-root"
    >
      <button
        onClick={() => {
          scopedRef.current = "dirty-ref";
          setState("dirty");
        }}
        type="button"
      >
        dirty
      </button>
    </section>
  );
}

function DeferredHarness({
  onNavigate,
  operation,
  projectId,
}: {
  onNavigate: (destination: string) => void;
  operation: Promise<string>;
  projectId: string;
}) {
  const session = useWorkbenchProjectSession(projectId);
  const [busy, setBusy] = useWorkbenchProjectState(session, () => false);
  const [error, setError] = useWorkbenchProjectState(session, () => "");

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const destination = await operation;
      if (session.isCurrent()) onNavigate(destination);
    } catch (cause) {
      if (session.isCurrent()) {
        setError(cause instanceof Error ? cause.message : "failed");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-busy={String(busy)}
      data-error={error}
      data-testid="project-root"
    >
      <button onClick={() => void run()} type="button">run</button>
    </section>
  );
}

const suspendedProject = new Promise<never>(() => undefined);

function SpeculativeProjectHarness({ operation }: { operation: Promise<string> }) {
  const [projectId, setProjectId] = useState("project-1");
  const [renderRequest, setRenderRequest] = useState(0);
  return (
    <>
      <button
        onClick={() => startTransition(() => setProjectId("project-2"))}
        type="button"
      >
        speculate
      </button>
      <button onClick={() => setRenderRequest((value) => value + 1)} type="button">
        rerender committed
      </button>
      <Suspense fallback={<div data-testid="project-fallback" />}>
        <SpeculativeProjectSession
          operation={operation}
          projectId={projectId}
          renderRequest={renderRequest}
        />
      </Suspense>
    </>
  );
}

function SpeculativeProjectSession({
  operation,
  projectId,
}: {
  operation: Promise<string>;
  projectId: string;
  renderRequest: number;
}) {
  const session = useWorkbenchProjectSession(projectId);
  const [state, setState] = useWorkbenchProjectState(session, () => "clean");
  const scopedRef = useWorkbenchProjectRef(session, () => "clean-ref");
  if (projectId === "project-2") throw suspendedProject;

  const run = async () => {
    const result = await operation;
    if (!session.isCurrent()) return;
    scopedRef.current = `${result}-ref`;
    setState(result);
  };

  return (
    <section
      data-ref={scopedRef.current}
      data-state={state}
      data-testid="project-root"
    >
      <button
        onClick={() => {
          scopedRef.current = "dirty-ref";
          setState("dirty");
        }}
        type="button"
      >
        dirty
      </button>
      <button onClick={() => void run()} type="button">run</button>
    </section>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
