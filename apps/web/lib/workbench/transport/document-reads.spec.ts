import { afterEach, expect, it, vi } from "vitest";
import { createDocumentReads } from "./document-reads";

afterEach(() => vi.unstubAllGlobals());

it.each(["next frame", "pageshow", "unmount"])(
  "resumes an interrupted document's GET on %s and sends mutations once",
  async (recovery) => {
    const events = new EventTarget();
    let render: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "window",
      Object.assign(events, {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          render = callback;
          return 1;
        },
        cancelAnimationFrame: () => {
          render = undefined;
        },
      }),
    );
    const send = vi.fn(async (_request: Request) =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", send);
    const reads = createDocumentReads();
    const cleanup = reads.observe();
    const read = new Request("http://localhost/api/v1/projects");
    const write = new Request(read, { method: "POST" });
    await reads.fetch(read);
    send.mockClear();
    const unload = new Event("beforeunload", { cancelable: true });
    expect(events.dispatchEvent(unload)).toBe(true);
    const pending = reads.fetch(read);
    await reads.fetch(write);
    expect(send.mock.calls).toEqual([[write]]);
    if (recovery === "next frame") render!(0);
    if (recovery === "pageshow") events.dispatchEvent(new Event("pageshow"));
    if (recovery === "unmount") cleanup();
    await pending;
    expect(send.mock.calls).toEqual([[write], [read]]);
    cleanup();
  },
);
