// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type {
  PrdDocument,
  PrototypeDocument,
  PrototypeNode,
} from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchArtifactContent } from "./workbench-artifact-content";
import { workbenchPrototypeSubmitEventName } from "../../lib/workbench/prototype-runtime";

const mocks = vi.hoisted(() => ({
  animate: vi.fn(),
  animationCancel: vi.fn(),
  fontAdd: vi.fn(),
  fontConstructor: vi.fn(),
  fontDelete: vi.fn(),
  fontLoad: vi.fn(),
  useArtifactVersion: vi.fn(),
  useArtifactVersionContent: vi.fn(),
  useArtifactVersionAsset: vi.fn(),
  usePublicArtifactVersion: vi.fn(),
  usePublicArtifactVersionContent: vi.fn(),
  usePublicArtifactVersionAsset: vi.fn(),
  usePrototypePatchProjection: vi.fn(),
  usePrototypePatchProjector: vi.fn(),
  queryClientSetData: vi.fn(),
  windowOpen: vi.fn(),
}));

vi.mock("../../lib/workbench/features/artifacts", () => ({
  useWorkbenchArtifactVersion: mocks.useArtifactVersion,
  useWorkbenchArtifactVersionContent: mocks.useArtifactVersionContent,
  useWorkbenchArtifactVersionAsset: mocks.useArtifactVersionAsset,
}));

vi.mock("../../lib/workbench/features/prototype-patches", () => ({
  usePrototypePatchProjection: mocks.usePrototypePatchProjection,
  usePrototypePatchProjector: mocks.usePrototypePatchProjector,
}));

vi.mock("../../lib/workbench/features/public-shares", () => ({
  useWorkbenchPublicSharedArtifactVersion: mocks.usePublicArtifactVersion,
  useWorkbenchPublicSharedArtifactContent: mocks.usePublicArtifactVersionContent,
  useWorkbenchPublicSharedArtifactAsset: mocks.usePublicArtifactVersionAsset,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => ({ setQueryData: mocks.queryClientSetData }),
}));

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: mocks.animate,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, "open", {
    configurable: true,
    value: mocks.windowOpen,
  });
  class FontFaceStub {
    constructor(family: string, source: string, descriptors?: FontFaceDescriptors) {
      mocks.fontConstructor(family, source, descriptors);
    }

    load() {
      return mocks.fontLoad(this);
    }
  }
  vi.stubGlobal("FontFace", FontFaceStub);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: mocks.fontAdd,
      delete: mocks.fontDelete,
    },
  });
});

beforeEach(() => {
  mocks.animationCancel.mockReset();
  mocks.animate.mockReset().mockImplementation(() => ({
    cancel: mocks.animationCancel,
    finished: Promise.resolve(),
  }));
  vi.mocked(URL.createObjectURL).mockReset().mockReturnValue("blob:prototype-asset");
  vi.mocked(URL.revokeObjectURL).mockReset();
  mocks.fontAdd.mockReset();
  mocks.fontConstructor.mockReset();
  mocks.fontDelete.mockReset();
  mocks.fontLoad.mockReset().mockImplementation(async (face) => face);
  mocks.usePublicArtifactVersion.mockReset().mockReturnValue(disabledQuery());
  mocks.usePublicArtifactVersionContent.mockReset().mockReturnValue(disabledQuery());
  mocks.useArtifactVersionContent.mockReset().mockReturnValue(disabledQuery());
  mocks.usePublicArtifactVersionAsset.mockReset().mockReturnValue(disabledQuery());
  mocks.usePrototypePatchProjection.mockReset().mockReturnValue(null);
  mocks.usePrototypePatchProjector.mockReset().mockReturnValue(null);
  mocks.queryClientSetData.mockReset();
  mocks.windowOpen.mockReset().mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  mocks.useArtifactVersion.mockReset();
  mocks.useArtifactVersionAsset.mockReset();
  mocks.usePublicArtifactVersion.mockReset();
  mocks.usePublicArtifactVersionContent.mockReset();
  mocks.usePublicArtifactVersionAsset.mockReset();
});

describe("Workbench Artifact content", () => {
  it("retries the selected ArtifactVersion query from its error state", async () => {
    const refetch = vi.fn(async () => undefined);
    mocks.useArtifactVersion.mockReturnValue({
      data: undefined,
      isError: true,
      isPending: false,
      refetch,
    });
    const user = userEvent.setup();

    render(<WorkbenchArtifactContent reference={reference()} />);
    await user.click(screen.getByRole("button", { name: "重试加载产物" }));

    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders a live Prototype projection while its ArtifactVersion query is pending", () => {
    const document = prototypeDocument();
    const button = document.nodes.find((node) => node.id === "button-open");
    if (!button || button.kind !== "button") throw new Error("button fixture missing");
    button.label = "Live Board patch";
    mocks.useArtifactVersion.mockReturnValue({
      data: undefined,
      isError: false,
      isPending: true,
    });
    mocks.usePrototypePatchProjection.mockReturnValue(prototypeProjection(document, "live"));

    render(<WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />);

    expect(screen.getByRole("button", { name: "Live Board patch" })).not.toBeNull();
    expect(screen.queryByText("Loading artifact...")).toBeNull();
  });

  it("keeps the generation placeholder while the first checkpoint is loading", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", prototypeDocument()));
    mocks.usePrototypePatchProjection.mockReturnValue(prototypeProjection(
      null,
      "checkpoint_loading",
    ));

    render(<WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />);

    expect(screen.getByText("Generating artifact...")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open success" })).toBeNull();
  });

  it("hands a finalized projection to Query only after the ready checksum matches", () => {
    const checkpointDocument = prototypeDocument();
    const checkpointButton = checkpointDocument.nodes.find((node) => node.id === "button-open");
    if (!checkpointButton || checkpointButton.kind !== "button") {
      throw new Error("checkpoint button fixture missing");
    }
    checkpointButton.label = "Checkpoint ready";
    const queryDocument = prototypeDocument();
    const queryButton = queryDocument.nodes.find((node) => node.id === "button-open");
    if (!queryButton || queryButton.kind !== "button") throw new Error("query button fixture missing");
    queryButton.label = "Query ready";
    const documentChecksum = "a".repeat(64);
    const releaseFinalized = vi.fn();
    mocks.usePrototypePatchProjector.mockReturnValue({ releaseFinalized });
    mocks.usePrototypePatchProjection.mockReturnValue(prototypeProjection(
      checkpointDocument,
      "finalized",
      documentChecksum,
    ));
    mocks.useArtifactVersion.mockReturnValue(readyPrototypeQuery(queryDocument, "b".repeat(64)));
    const rendered = render(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />,
    );
    expect(screen.getByRole("button", { name: "Checkpoint ready" })).not.toBeNull();

    mocks.useArtifactVersion.mockReturnValue(readyPrototypeQuery(queryDocument, documentChecksum));
    rendered.rerender(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />,
    );

    expect(screen.getByRole("button", { name: "Query ready" })).not.toBeNull();
    expect(screen.queryByText("Loading artifact...")).toBeNull();
    expect(mocks.queryClientSetData).toHaveBeenCalledWith(
      [
        "workbench",
        "projects",
        "detail",
        "project-1",
        "artifacts",
        "detail",
        "artifact-1",
        "versions",
        "version-1",
      ],
      expect.objectContaining({ value: expect.objectContaining({ checksum: documentChecksum }) }),
    );
    expect(releaseFinalized).toHaveBeenCalledWith("version-1");
    expect(mocks.queryClientSetData.mock.invocationCallOrder[0])
      .toBeLessThan(releaseFinalized.mock.invocationCallOrder[0]!);
  });

  it("renders the persisted structured PRD instead of demo copy", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prd", prdDocument()));

    render(<WorkbenchArtifactContent reference={reference()} />);

    expect(screen.getByRole("heading", { name: "Production PRD" })).not.toBeNull();
    expect(screen.getByText("Real executive summary")).not.toBeNull();
    expect(screen.queryByText(/打卡签到功能需求文档/)).toBeNull();
  });

  it("preserves PRD inline marks, links, citations, and references in view mode", () => {
    const document = prdDocument();
    document.sections.executiveSummary.blocks = [{
      id: "block-inline-semantics",
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Important",
          marks: ["strong", "emphasis", "code", "strikethrough"],
        },
        { type: "link", text: "Source", href: "https://example.com/source" },
        { type: "citation", citationId: "citation-1", label: "[1]" },
        {
          type: "reference",
          targetType: "requirement",
          targetId: "requirement-1",
          label: "Requirement 1",
        },
      ],
    }];
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prd", document));

    const rendered = render(<WorkbenchArtifactContent reference={reference()} />);

    for (const selector of ["strong", "em", "code", "del"]) {
      expect(rendered.container.querySelector(selector)?.textContent).toBe("Important");
    }
    expect(screen.getByRole("link", { name: "Source" }).getAttribute("href"))
      .toBe("https://example.com/source");
    expect(rendered.container.querySelector('[data-prd-citation-id="citation-1"]')?.textContent)
      .toBe("[1]");
    expect(rendered.container.querySelector('[data-prd-reference-id="requirement-1"]')
      ?.getAttribute("data-prd-reference-type")).toBe("requirement");
  });

  it("exposes the same persisted PRD through the edit command when enabled", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prd", prdDocument()));
    const onPrdDocumentCommit = vi.fn(async () => undefined);

    render(
      <WorkbenchArtifactContent
        editable
        onPrdDocumentCommit={onPrdDocumentCommit}
        reference={reference()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "PRD 编辑器" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Production PRD" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "保存 PRD" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders authenticated blob-backed image Artifact content", async () => {
    const content = new Blob(["image"], { type: "image/png" });
    mocks.useArtifactVersion.mockReturnValue(blobArtifactQuery("image"));
    mocks.useArtifactVersionContent.mockReturnValue(assetQuery(content));

    const rendered = render(<WorkbenchArtifactContent reference={reference()} />);

    const image = await screen.findByRole("img", { name: "图片产物" });
    expect(image.getAttribute("src")).toBe("blob:prototype-asset");
    expect(mocks.useArtifactVersionContent).toHaveBeenCalledWith(
      "project-1",
      "artifact-1",
      "version-1",
    );
    rendered.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:prototype-asset");
  });

  it("renders token-authorized public blob-backed image content and revokes its URL", async () => {
    const content = new Blob(["shared-image"], { type: "image/webp" });
    mocks.useArtifactVersion.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersion.mockReturnValue(blobArtifactQuery("image"));
    mocks.usePublicArtifactVersionContent.mockReturnValue(assetQuery(content));

    const rendered = render(
      <WorkbenchArtifactContent reference={{ ...reference(), shareToken: "wbs_public" }} />,
    );

    const image = await screen.findByRole("img", { name: "图片产物" });
    expect(image.getAttribute("src")).toBe("blob:prototype-asset");
    expect(mocks.usePublicArtifactVersionContent).toHaveBeenCalledWith(
      "wbs_public",
      "artifact-1",
      "version-1",
    );
    expect(mocks.useArtifactVersionContent).not.toHaveBeenCalled();
    rendered.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:prototype-asset");
  });

  it.each(["code", "document", "data"] as const)(
    "renders token-authorized public %s bytes as bounded text",
    async (kind) => {
      const text = `shared-${kind}`;
      mocks.useArtifactVersion.mockReturnValue(disabledQuery());
      mocks.usePublicArtifactVersion.mockReturnValue(blobArtifactQuery(kind));
      mocks.usePublicArtifactVersionContent.mockReturnValue(assetQuery(
        new Blob([text], { type: "text/plain" }),
      ));

      render(<WorkbenchArtifactContent reference={{ ...reference(), shareToken: "wbs_public" }} />);

      expect(await screen.findByText(text)).not.toBeNull();
      expect(mocks.usePublicArtifactVersionContent).toHaveBeenCalledWith(
        "wbs_public",
        "artifact-1",
        "version-1",
      );
    },
  );

  it("executes Prototype navigation actions within the immutable ArtifactVersion", async () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", prototypeDocument()));
    const user = userEvent.setup();

    render(<WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />);
    await user.click(screen.getByRole("button", { name: "Open success" }));

    expect(screen.getByText("Success screen")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open success" })).toBeNull();
  });

  it("preserves navigation and does not replay enter motion across live document updates", async () => {
    const initialDocument = prototypeDocumentWithSuccessEnterMotion();
    let projection = prototypeProjection(initialDocument, "live");
    mocks.useArtifactVersion.mockReturnValue(disabledQuery());
    mocks.usePrototypePatchProjection.mockImplementation(() => projection);
    const rendered = render(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open success" }));
    await waitFor(() => expect(mocks.animate).toHaveBeenCalledOnce());

    const nextDocument = structuredClone(initialDocument);
    const success = nextDocument.nodes.find((node) => node.id === "text-success");
    if (!success || success.kind !== "text") throw new Error("success fixture missing");
    success.text = "Patched success screen";
    projection = prototypeProjection(nextDocument, "live");
    rendered.rerender(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-home" }} />,
    );

    expect(screen.getByText("Patched success screen")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open success" })).toBeNull();
    await waitFor(() => expect(mocks.animate).toHaveBeenCalledOnce());
  });

  it("preserves user-modified inputs across live document updates", () => {
    const initialDocument = interactivePrototypeDocument();
    let projection = prototypeProjection(initialDocument, "live", null, "screen-form");
    mocks.useArtifactVersion.mockReturnValue(disabledQuery());
    mocks.usePrototypePatchProjection.mockImplementation(() => projection);
    const rendered = render(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-form" }} />,
    );
    const email = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement;
    fireEvent.change(email, { target: { value: "owner@example.com" } });

    const nextDocument = structuredClone(initialDocument);
    const notes = nextDocument.nodes.find((node) => node.id === "input-notes");
    if (!notes || notes.kind !== "input") throw new Error("notes fixture missing");
    notes.placeholder = "Updated notes";
    projection = prototypeProjection(nextDocument, "live", null, "screen-form");
    rendered.rerender(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-form" }} />,
    );

    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value)
      .toBe("owner@example.com");
    expect((screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement).placeholder)
      .toBe("Updated notes");
  });

  it("executes real Prototype inputs, bindings, state, submit detail, icons, and motion", async () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      interactivePrototypeDocument(),
    ));
    const submissions: unknown[] = [];
    const onSubmit = (event: Event) => submissions.push((event as CustomEvent).detail);
    window.addEventListener(workbenchPrototypeSubmitEventName, onSubmit);

    try {
      render(<WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-form" }} />);
      const user = userEvent.setup();
      const email = screen.getByRole("textbox", { name: "Email" });
      expect(email.tagName).toBe("INPUT");
      expect(screen.getByRole("textbox", { name: "Notes" }).tagName).toBe("TEXTAREA");
      expect(screen.getByRole("combobox", { name: "Plan" }).tagName).toBe("SELECT");
      const accept = screen.getByRole("checkbox", { name: "Accept" });
      expect(accept).not.toBeNull();

      await user.type(email, "team@example.com");
      expect(screen.getByText("team@example.com")).not.toBeNull();
      await user.tab();
      expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();

      await waitFor(() => {
        expect(screen.getByLabelText("Success icon").querySelector("svg")).not.toBeNull();
      });
      await user.click(accept);
      await user.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Submitted" })).not.toBeNull());
      expect(submissions).toEqual([{
        protocol: "workbench.prototype-submit.v1",
        actionId: "action-submit-form",
        documentId: "prototype-interactive",
        formNodeId: "form-main",
        kind: "submit",
        screenId: "screen-form",
        values: [{
          bindingId: "binding-email",
          fieldName: "email",
          nodeId: "input-email",
          value: "team@example.com",
        }],
      }]);
      expect(mocks.animate).toHaveBeenCalledWith(
        [{ opacity: 0.4 }, { opacity: 1 }],
        expect.objectContaining({ duration: 160, easing: "ease-out", fill: "both" }),
      );
    } finally {
      window.removeEventListener(workbenchPrototypeSubmitEventName, onSubmit);
    }
  });

  it("renders a date input and preserves its canonical value through the runtime binding", () => {
    const document = interactivePrototypeDocument();
    const input = document.nodes.find((node) => node.id === "input-email");
    if (input?.kind !== "input") throw new Error("date input fixture missing");
    input.inputType = "date";
    input.fieldName = "startDate";
    input.label = "Start date";
    input.placeholder = "YYYY-MM-DD";
    const variable = document.variables.find((candidate) => candidate.path === "form.email");
    if (!variable) throw new Error("date variable fixture missing");
    variable.initialValue = "2026-07-16";
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", document));

    render(<WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-form" }} />);

    const rendered = screen.getByLabelText("Start date") as HTMLInputElement;
    expect(rendered.type).toBe("date");
    expect(rendered.value).toBe("2026-07-16");
    fireEvent.change(rendered, { target: { value: "2026-08-01" } });
    expect(rendered.value).toBe("2026-08-01");
    expect(screen.getByText("2026-08-01")).not.toBeNull();
  });

  it("emits one submit event for duplicate activations in the same in-flight window", async () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      interactivePrototypeDocument(),
    ));
    const submissions: unknown[] = [];
    const onSubmit = (event: Event) => submissions.push((event as CustomEvent).detail);
    window.addEventListener(workbenchPrototypeSubmitEventName, onSubmit);

    try {
      const rendered = render(
        <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-form" }} />,
      );
      const form = rendered.container.querySelector("form");
      if (!form) throw new Error("Prototype form was not rendered");

      fireEvent.submit(form);
      fireEvent.submit(form);

      await waitFor(() => expect(submissions).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(submissions).toHaveLength(1);

      fireEvent.submit(form);
      await waitFor(() => expect(submissions).toHaveLength(2));
    } finally {
      window.removeEventListener(workbenchPrototypeSubmitEventName, onSubmit);
    }
  });

  it("starts a private Prototype preview on the explicitly referenced screen", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", prototypeDocument()));

    const rendered = render(
      <WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-success" }} />,
    );

    expect(screen.getByText("Success screen")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open success" })).toBeNull();
    expect(rendered.container.querySelector("[data-canvas-visual-screen]")).toMatchObject({
      dataset: expect.objectContaining({
        canvasArtifactId: "artifact-1",
        canvasArtifactVersionId: "version-1",
        canvasScreenId: "screen-success",
      }),
    });
  });

  it("refuses an explicit screen outside the private ArtifactVersion instead of using its first screen", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", prototypeDocument()));

    render(<WorkbenchArtifactContent reference={{ ...reference(), screenId: "screen-missing" }} />);

    expect(screen.getByText("Artifact screen unavailable")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open success" })).toBeNull();
  });

  it("refuses an explicit screen outside the public pinned ArtifactVersion", () => {
    mocks.useArtifactVersion.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersion.mockReturnValue(artifactQuery("prototype", prototypeDocument()));

    render(<WorkbenchArtifactContent reference={{
      ...reference(),
      screenId: "screen-missing",
      shareToken: "wbs_public",
    }} />);

    expect(screen.getByText("Artifact screen unavailable")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open success" })).toBeNull();
  });

  it("marks real Prototype nodes for the editor and suspends runtime actions while editing", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", prototypeDocument()));
    const onDocumentCommit = vi.fn(async () => undefined);

    const rendered = render(
      <WorkbenchArtifactContent
        editable
        onDocumentCommit={onDocumentCommit}
        reference={{ ...reference(), screenId: "screen-home" }}
      />,
    );

    expect(rendered.container.querySelector('[data-prototype-editor="active"]')).not.toBeNull();
    expect(rendered.container.querySelectorAll("[data-prototype-node-id]").length).toBeGreaterThan(1);
    expect((screen.getByRole("button", { name: "Open success" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open success" }));
    expect(screen.queryByText("Success screen")).toBeNull();
    expect(onDocumentCommit).not.toHaveBeenCalled();
  });

  it("renders static rotation and border-box origin from the active Prototype style", () => {
    const document = prototypeDocument();
    const button = document.nodes.find((node) => node.id === "button-open")!;
    const overrideStyle = structuredClone(button.style);
    overrideStyle.rotation = -45;
    overrideStyle.transformOrigin = { x: 0.25, y: 0.8 };
    document.screens[0]!.initialStateId = "state-rotated";
    document.states = [{
      id: "state-rotated",
      screenId: "screen-home",
      name: "Rotated",
      values: {},
      overrides: [{ nodeId: button.id, style: overrideStyle }],
    }];
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", document));

    render(<WorkbenchArtifactContent reference={reference()} />);

    const rendered = screen.getByRole("button", { name: "Open success" });
    expect(rendered.style.transform).toBe("rotate(-45deg)");
    expect(rendered.style.transformBox).toBe("border-box");
    expect(rendered.style.transformOrigin).toBe("25% 80%");
  });

  it.each([
    "https://example.com/prototype",
    "mailto:designer@example.com?subject=Prototype%20review",
    "tel:+8613800138000",
  ])("opens the explicitly supported Prototype URL %s", async (url) => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      openUrlPrototypeDocument(url),
    ));

    render(<WorkbenchArtifactContent reference={reference()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open success" }));

    expect(mocks.windowOpen).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///tmp/unsafe",
    "blob:https://example.com/unsafe",
  ])("blocks a forged unsafe Prototype URL at navigation time: %s", async (url) => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      openUrlPrototypeDocument(url),
    ));

    render(<WorkbenchArtifactContent reference={reference()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open success" }));

    expect(mocks.windowOpen).not.toHaveBeenCalled();
  });

  it("blocks a forged unsafe openUrl in the public share renderer", async () => {
    mocks.useArtifactVersion.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      openUrlPrototypeDocument("javascript:alert(document.domain)"),
    ));

    render(<WorkbenchArtifactContent reference={{ ...reference(), shareToken: "wbs_public" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Open success" }));

    expect(mocks.windowOpen).not.toHaveBeenCalled();
    expect(mocks.usePublicArtifactVersion).toHaveBeenCalledWith(
      "wbs_public",
      "artifact-1",
      "version-1",
      true,
    );
  });

  it("renders the state-overridden image asset and revokes its object URL", async () => {
    const content = new Blob(["image"], { type: "image/webp" });
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      imagePrototypeDocument(),
    ));
    mocks.useArtifactVersionAsset.mockReturnValue(assetQuery(content));

    const rendered = render(<WorkbenchArtifactContent reference={reference()} />);

    const image = await screen.findByRole("img", { name: "Hero image" });
    expect(image.getAttribute("src")).toBe("blob:prototype-asset");
    expect(image.style.objectFit).toBe("cover");
    expect(mocks.useArtifactVersionAsset).toHaveBeenCalledWith(
      "project-1",
      "artifact-1",
      "version-1",
      "image-secondary",
      true,
    );

    rendered.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:prototype-asset");
  });

  it("shows an accessible image failure and reloads the same asset after decode failure", async () => {
    const content = new Blob(["invalid-image"], { type: "image/webp" });
    const refetch = vi.fn(async () => undefined);
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce("blob:prototype-asset")
      .mockReturnValueOnce("blob:prototype-asset-retry");
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      imagePrototypeDocument(),
    ));
    mocks.useArtifactVersionAsset.mockReturnValue({ ...assetQuery(content), refetch });
    render(<WorkbenchArtifactContent reference={reference()} />);

    fireEvent.error(await screen.findByRole("img", { name: "Hero image" }));

    expect((await screen.findByRole("alert", { name: "Hero image 加载失败" })).hidden)
      .toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:prototype-asset");

    await userEvent.click(screen.getByRole("button", { name: "重试加载图片：Hero image" }));

    expect(refetch).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Hero image" }).getAttribute("src"))
        .toBe("blob:prototype-asset-retry");
    });
  });

  it("shows a retryable failure when authorized asset loading fails", async () => {
    const refetch = vi.fn(async () => undefined);
    const document = imagePrototypeDocument();
    const image = document.nodes.find((node) => node.id === "image-hero");
    if (!image) throw new Error("image fixture missing");
    image.actionIds = ["action-image-open"];
    document.actions = [{
      id: "action-image-open",
      nodeId: image.id,
      event: "click",
      kind: "openUrl",
      url: "https://example.com/image",
      target: "newWindow",
    }];
    mocks.useArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      document,
    ));
    mocks.useArtifactVersionAsset.mockReturnValue({
      data: undefined,
      isError: true,
      isPending: false,
      refetch,
    });

    render(<WorkbenchArtifactContent reference={reference()} />);

    const placeholder = screen.getByLabelText("Hero image");
    expect(placeholder.tagName).toBe("DIV");
    expect(placeholder.style.width).toBe("390px");
    expect(placeholder.style.height).toBe("844px");
    expect(screen.getByRole("alert", { name: "Hero image 加载失败" }).textContent)
      .toContain("图片加载失败");
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "重试加载图片：Hero image" }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(mocks.windowOpen).not.toHaveBeenCalled();
  });

  it("registers immutable WOFF2 content and releases the font and URL on unmount", async () => {
    const content = new Blob(["font"], { type: "font/woff2" });
    const document = prototypeDocument();
    document.assets = [{
      id: "font-product",
      kind: "font",
      name: "Product Sans",
      blobId: "blob-font",
      mediaType: "font/woff2",
      byteSize: 4,
      sha256: "c".repeat(64),
      family: "Product Sans",
      weight: 600,
      style: "normal",
    }];
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prototype", document));
    mocks.useArtifactVersionAsset.mockReturnValue(assetQuery(content));

    const rendered = render(<WorkbenchArtifactContent reference={reference()} />);
    await waitFor(() => expect(mocks.fontAdd).toHaveBeenCalledOnce());

    expect(mocks.fontConstructor).toHaveBeenCalledWith(
      "Product Sans",
      'url("blob:prototype-asset") format("woff2")',
      { style: "normal", weight: "600" },
    );
    expect(mocks.useArtifactVersionAsset).toHaveBeenCalledWith(
      "project-1",
      "artifact-1",
      "version-1",
      "font-product",
      true,
    );

    rendered.unmount();
    expect(mocks.fontDelete).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:prototype-asset");
  });

  it("uses only token-authorized public version and asset routes for a shared Prototype", async () => {
    const content = new Blob(["shared-image"], { type: "image/webp" });
    const document = imagePrototypeDocument();
    const publicDocument = {
      ...document,
      assets: document.assets.map((asset) => {
        if (asset.kind === "icon") return asset;
        const { blobId: _blobId, ...publicAsset } = asset;
        return publicAsset;
      }),
    };
    mocks.useArtifactVersion.mockReturnValue(disabledQuery());
    mocks.useArtifactVersionAsset.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersion.mockReturnValue(artifactQuery(
      "prototype",
      publicDocument as PrototypeDocument,
    ));
    mocks.usePublicArtifactVersionAsset.mockReturnValue(assetQuery(content));

    render(<WorkbenchArtifactContent reference={{ ...reference(), shareToken: "wbs_public" }} />);

    expect((await screen.findByRole("img", { name: "Hero image" })).getAttribute("src"))
      .toBe("blob:prototype-asset");
    expect(mocks.useArtifactVersion).toHaveBeenCalledWith(
      "project-1",
      "artifact-1",
      "version-1",
      false,
    );
    expect(mocks.usePublicArtifactVersion).toHaveBeenCalledWith(
      "wbs_public",
      "artifact-1",
      "version-1",
      true,
    );
    expect(mocks.usePublicArtifactVersionAsset).toHaveBeenCalledWith(
      "wbs_public",
      "artifact-1",
      "version-1",
      "image-secondary",
      true,
    );
  });
});

function reference() {
  return {
    projectId: "project-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
  };
}

function artifactQuery(kind: "prd" | "prototype", content: PrdDocument | PrototypeDocument) {
  return {
    data: {
      value: {
        contentMode: "inline",
        kind,
        content,
      },
    },
    isPending: false,
    isError: false,
  };
}

function readyPrototypeQuery(content: PrototypeDocument, checksum: string) {
  return {
    data: {
      value: {
        checksum,
        content,
        contentMode: "inline" as const,
        kind: "prototype" as const,
        status: "ready" as const,
      },
    },
    isPending: false,
    isError: false,
  };
}

function prototypeProjection(
  document: PrototypeDocument | null,
  phase: "checkpoint_loading" | "live" | "finalized",
  documentChecksum: string | null = null,
  screenId = "screen-home",
) {
  return {
    artifactId: "artifact-1",
    artifactIndex: 0,
    artifactVersionId: "version-1",
    checksum: document ? "b".repeat(64) : null,
    document,
    documentChecksum,
    issue: null,
    phase,
    revision: document ? 1 : null,
    screenId,
  };
}

function blobArtifactQuery(kind: "image" | "code" | "document" | "data") {
  return {
    data: { value: { contentMode: "blob", kind } },
    isPending: false,
    isError: false,
  };
}

function assetQuery(content: Blob) {
  return {
    data: content,
    isError: false,
    isPending: false,
  };
}

function disabledQuery() {
  return { data: undefined, isError: false, isPending: false };
}

function prdDocument(): PrdDocument {
  const sections = Object.fromEntries([
    "executiveSummary",
    "problem",
    "goals",
    "targetUsers",
    "scope",
    "requirements",
    "userFlows",
    "acceptanceCriteria",
    "risksAndDependencies",
  ].map((key) => [key, {
    title: key,
    blocks: [{
      id: `block-${key}`,
      type: "paragraph",
      content: [{ type: "text", text: key === "executiveSummary" ? "Real executive summary" : key, marks: [] }],
    }],
  }])) as unknown as PrdDocument["sections"];
  return {
    protocol: "workbench.prd.v1",
    documentId: "prd-doc",
    title: "Production PRD",
    revision: {
      number: 1,
      status: "draft",
      summary: "Initial",
      changedAt: "2026-07-13T00:00:00.000Z",
      changedById: null,
    },
    assumptions: [],
    citations: [],
    sections,
  };
}

function prototypeDocument(): PrototypeDocument {
  const homeRoot = frame("frame-home", "screen-home", ["button-open"]);
  const successRoot = frame("frame-success", "screen-success", ["text-success"]);
  const button = {
    ...nodeBase("button-open", "screen-home", "frame-home"),
    kind: "button" as const,
    label: "Open success",
    childIds: [],
    buttonType: "button" as const,
    disabled: false,
    actionIds: ["action-open"],
  };
  const successText = {
    ...nodeBase("text-success", "screen-success", "frame-success"),
    kind: "text" as const,
    text: "Success screen",
    maxLines: 1,
  };
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-doc",
    title: "Prototype",
    revision: 1,
    screens: [
      { id: "screen-home", name: "Home", route: "/", rootNodeId: homeRoot.id, initialStateId: null, viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: successRoot.id, initialStateId: null, viewport: { width: 390, height: 844 } },
    ],
    nodes: [homeRoot, button, successRoot, successText],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [{
      id: "action-open",
      nodeId: button.id,
      event: "click",
      kind: "navigate",
      targetScreenId: "screen-success",
    }],
    bindings: [],
    motions: [],
  };
}

function prototypeDocumentWithSuccessEnterMotion(): PrototypeDocument {
  const document = prototypeDocument();
  const success = document.nodes.find((node) => node.id === "text-success");
  if (!success) throw new Error("success fixture missing");
  success.motionIds = ["motion-success-enter"];
  document.motions = [{
    id: "motion-success-enter",
    nodeId: success.id,
    trigger: "enter",
    stateId: null,
    actionId: null,
    property: "opacity",
    from: 0,
    to: 1,
    duration: { kind: "literal", value: 160 },
    delay: { kind: "literal", value: 0 },
    easing: "easeOut",
  }];
  return document;
}

function imagePrototypeDocument(): PrototypeDocument {
  const root = frame("frame-image", "screen-image", ["image-hero"]);
  const image = {
    ...nodeBase("image-hero", "screen-image", root.id),
    kind: "image" as const,
    assetId: "image-primary",
    fit: "cover" as const,
    alt: "Hero image",
  };
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-images",
    title: "Image Prototype",
    revision: 1,
    screens: [{
      id: "screen-image",
      name: "Image",
      route: "/",
      rootNodeId: root.id,
      initialStateId: "state-image",
      viewport: { width: 390, height: 844 },
    }],
    nodes: [root, image],
    tokens: [],
    assets: [
      {
        id: "image-primary",
        kind: "image",
        name: "Primary image",
        blobId: "blob-primary",
        mediaType: "image/png",
        byteSize: 5,
        sha256: "a".repeat(64),
        width: 390,
        height: 844,
      },
      {
        id: "image-secondary",
        kind: "image",
        name: "Secondary image",
        blobId: "blob-secondary",
        mediaType: "image/webp",
        byteSize: 5,
        sha256: "b".repeat(64),
        width: 390,
        height: 844,
      },
    ],
    variables: [],
    states: [{
      id: "state-image",
      screenId: "screen-image",
      name: "Secondary",
      values: {},
      overrides: [{ nodeId: image.id, assetId: "image-secondary" }],
    }],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function openUrlPrototypeDocument(url: string): PrototypeDocument {
  const document = prototypeDocument();
  document.actions = [{
    id: "action-open",
    nodeId: "button-open",
    event: "click",
    kind: "openUrl",
    url,
    target: "newWindow",
  }];
  return document;
}

function interactivePrototypeDocument(): PrototypeDocument {
  const screenId = "screen-form";
  const root = frame("frame-form", screenId, ["form-main"]);
  const form = {
    ...nodeBase("form-main", screenId, root.id),
    kind: "form" as const,
    childIds: [
      "input-email",
      "input-notes",
      "input-plan",
      "input-accept",
      "text-email-preview",
      "icon-success",
      "button-submit-form",
    ],
    actionIds: ["action-submit-form"],
  };
  const email = {
    ...nodeBase("input-email", screenId, form.id),
    kind: "input" as const,
    inputType: "email" as const,
    fieldName: "email",
    label: "Email",
    placeholder: "team@example.com",
    optionValue: null,
    options: [],
    required: true,
    disabled: false,
    actionIds: ["action-focus-email", "action-blur-email"],
    bindingIds: ["binding-email"],
  };
  const notes = {
    ...nodeBase("input-notes", screenId, form.id),
    kind: "input" as const,
    inputType: "textarea" as const,
    fieldName: "notes",
    label: "Notes",
    placeholder: "Notes",
    optionValue: null,
    options: [],
    required: false,
    disabled: false,
    bindingIds: ["binding-notes"],
  };
  const plan = {
    ...nodeBase("input-plan", screenId, form.id),
    kind: "input" as const,
    inputType: "select" as const,
    fieldName: "plan",
    label: "Plan",
    placeholder: "Choose plan",
    optionValue: null,
    options: [
      { value: "Starter", label: "Starter", disabled: false },
      { value: "Pro", label: "Pro", disabled: false },
    ],
    required: true,
    disabled: false,
    bindingIds: ["binding-plan"],
  };
  const accept = {
    ...nodeBase("input-accept", screenId, form.id),
    kind: "input" as const,
    inputType: "checkbox" as const,
    fieldName: "accept",
    label: "Accept",
    placeholder: "",
    optionValue: null,
    options: [],
    required: true,
    disabled: false,
    bindingIds: ["binding-accept"],
  };
  const preview = {
    ...nodeBase("text-email-preview", screenId, form.id),
    kind: "text" as const,
    text: "No email",
    maxLines: 1,
    bindingIds: ["binding-email-preview"],
  };
  const icon = {
    ...nodeBase("icon-success", screenId, form.id),
    kind: "icon" as const,
    assetId: "asset-circle-check",
    accessibilityLabel: "Success icon",
  };
  const button = {
    ...nodeBase("button-submit-form", screenId, form.id),
    kind: "button" as const,
    label: "Send",
    childIds: [],
    buttonType: "submit" as const,
    disabled: false,
    actionIds: [],
    motionIds: ["motion-submit-form"],
  };
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-interactive",
    title: "Interactive Prototype",
    revision: 1,
    screens: [{
      id: screenId,
      name: "Form",
      route: "/form",
      rootNodeId: root.id,
      initialStateId: "state-idle",
      viewport: { width: 390, height: 844 },
    }],
    nodes: [root, form, email, notes, plan, accept, preview, icon, button],
    tokens: [],
    assets: [{
      id: "asset-circle-check",
      kind: "icon",
      name: "Circle check",
      library: "lucide",
      iconName: "CircleCheck",
    }],
    variables: [
      { path: "form.email", initialValue: "" },
      { path: "form.notes", initialValue: "" },
      { path: "form.plan", initialValue: "Starter" },
      { path: "form.accept", initialValue: false },
    ],
    states: [
      { id: "state-idle", screenId, name: "Idle", values: {}, overrides: [{ nodeId: button.id, text: "Send" }] },
      { id: "state-focused", screenId, name: "Focused", values: {}, overrides: [{ nodeId: button.id, text: "Focused" }] },
      { id: "state-submitted", screenId, name: "Submitted", values: {}, overrides: [{ nodeId: button.id, text: "Submitted" }] },
    ],
    actions: [
      { id: "action-focus-email", nodeId: email.id, event: "focus", kind: "setState", targetStateId: "state-focused" },
      { id: "action-blur-email", nodeId: email.id, event: "blur", kind: "setState", targetStateId: "state-idle" },
      { id: "action-submit-form", nodeId: form.id, event: "submit", kind: "submit", bindingIds: ["binding-email"], successStateId: "state-submitted" },
    ],
    bindings: [
      { id: "binding-email", nodeId: email.id, property: "value", source: { kind: "variable", path: "form.email" } },
      { id: "binding-notes", nodeId: notes.id, property: "value", source: { kind: "variable", path: "form.notes" } },
      { id: "binding-plan", nodeId: plan.id, property: "value", source: { kind: "variable", path: "form.plan" } },
      { id: "binding-accept", nodeId: accept.id, property: "value", source: { kind: "variable", path: "form.accept" } },
      { id: "binding-email-preview", nodeId: preview.id, property: "text", source: { kind: "variable", path: "form.email" } },
    ],
    motions: [{
      id: "motion-submit-form",
      nodeId: button.id,
      trigger: "action",
      stateId: null,
      actionId: "action-submit-form",
      property: "opacity",
      from: 0.4,
      to: 1,
      duration: { kind: "literal", value: 160 },
      delay: { kind: "literal", value: 0 },
      easing: "easeOut",
    }],
  };
}

function frame(id: string, screenId: string, childIds: string[]): PrototypeNode {
  return {
    ...nodeBase(id, screenId, null),
    kind: "frame",
    childIds,
    clipContent: true,
  };
}

function nodeBase(id: string, screenId: string, parentId: string | null) {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    id,
    screenId,
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "flex" as const,
      direction: "column" as const,
      gap: literal(8),
      padding: { top: literal(16), right: literal(16), bottom: literal(16), left: literal(16) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: { kind: "literal" as const, value: "#ffffff" },
      stroke: null,
      radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [] as string[],
    bindingIds: [] as string[],
    motionIds: [] as string[],
  };
}
