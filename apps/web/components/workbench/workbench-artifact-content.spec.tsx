// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  prdSafetyBaselineIntro,
  prdSafetyBaselineItems,
  prdTableOfContentsEntries,
  type PrdBlock,
  type PrdDocument,
  type PrdDocumentV1,
  type PrdDocumentV2,
  type PrdInline,
  type PrototypeDocument,
  type PrototypeNode,
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
  it("reports version query readiness while allowing a parent-owned pending surface", async () => {
    const onStateChange = vi.fn();
    const onTitleChange = vi.fn();
    mocks.useArtifactVersion.mockReturnValue({
      data: undefined,
      isError: false,
      isPending: true,
    });
    const rendered = render(
      <WorkbenchArtifactContent
        onArtifactTitleChange={onTitleChange}
        onArtifactVersionStateChange={onStateChange}
        pendingContent={null}
        reference={reference()}
      />,
    );

    expect(rendered.container.childElementCount).toBe(0);
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith("pending"));

    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prd", prdDocument()));
    rendered.rerender(
      <WorkbenchArtifactContent
        onArtifactTitleChange={onTitleChange}
        onArtifactVersionStateChange={onStateChange}
        pendingContent={null}
        reference={reference()}
      />,
    );

    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith("ready"));
    await waitFor(() => expect(onTitleChange).toHaveBeenLastCalledWith("Production PRD"));
    expect(screen.getByRole("heading", { name: "Production PRD" })).not.toBeNull();
  });

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

    const rendered = render(<WorkbenchArtifactContent reference={reference()} />);

    expect(screen.getByRole("heading", { name: "Production PRD" })).not.toBeNull();
    expect(screen.getByText("Real executive summary")).not.toBeNull();
    expect(screen.queryByText(/打卡签到功能需求文档/)).toBeNull();
    const article = rendered.container.querySelector("article");
    expect(article?.classList.contains("nowheel")).toBe(true);
    expect(article?.classList.contains("overflow-auto")).toBe(true);
  });

  it("keeps numbered v1 headings singular and localizes scenario labels", () => {
    const document = prdDocument();
    document.sections.executiveSummary.title = "1 引言";
    document.sections.acceptanceCriteria.blocks = [{
      id: "criterion-localized",
      type: "acceptanceCriterion",
      requirementIds: [],
      given: [{ type: "text", text: "用户已登录", marks: [] }],
      when: [{ type: "text", text: "用户提交订单", marks: [] }],
      then: [{ type: "text", text: "系统创建订单", marks: [] }],
    }];
    document.sections.risksAndDependencies.blocks = [{
      id: "risk-localized",
      type: "risk",
      description: [{ type: "text", text: "依赖服务不可用", marks: [] }],
      likelihood: "low",
      impact: "medium",
      mitigation: [{ type: "text", text: "启用本地降级", marks: [] }],
    }];
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prd", document));

    render(<WorkbenchArtifactContent reference={reference()} />);

    expect(screen.getByRole("heading", { name: "1 引言" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "1. 1 引言" })).toBeNull();
    expect(screen.getByText("前置条件：")).not.toBeNull();
    expect(screen.getByText("触发操作：")).not.toBeNull();
    expect(screen.getByText("预期结果：")).not.toBeNull();
    expect(screen.getByText(/缓解措施：/u)).not.toBeNull();
    expect(screen.queryByText(/^(Given|When|Then|Mitigation)/u)).toBeNull();
  });

  it("renders the complete v2 requirement template with canonical channels, diagrams, and 21 safety rows", () => {
    mocks.useArtifactVersion.mockReturnValue(artifactQuery("prd", prdV2Document()));

    const rendered = render(<WorkbenchArtifactContent reference={reference()} />);

    expect(screen.getByRole("heading", { name: "支付体验优化需求说明书" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "版 本 历 史" })).not.toBeNull();
    expect(screen.getByText("版本/状态")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "需求说明书目录" })).not.toBeNull();
    for (const title of [
      "1 引言",
      "1.1项目背景",
      "1.2文档范围",
      "1.3使用场景（必填）",
      "2 业务需求",
      "2.1页面链接",
      "2.2 核心业务规则/功能说明",
      "2.3 核心流程/状态/页面要求",
      "2.4 验收标准",
      "3 业务降级方案（必填）",
      "4 需求安全基线要求（必填）",
    ]) {
      expect(screen.getByRole("heading", { name: title })).not.toBeNull();
    }
    expect(rendered.container.querySelectorAll("[data-prd-channel-table]")).toHaveLength(1);
    expect(screen.getByText("端内渠道")).not.toBeNull();
    expect(screen.getByText("WAP/H5端外渠道")).not.toBeNull();
    expect(screen.getByText("小程序")).not.toBeNull();
    expect(screen.getAllByText("☑是 □否")).toHaveLength(2);
    expect(screen.getByText("□是 ☑否")).not.toBeNull();
    expect(rendered.container.querySelectorAll("[data-prd-diagram]")).toHaveLength(2);
    expect(rendered.container.querySelectorAll("[data-prd-diagram-node]")).toHaveLength(8);
    expect(rendered.container.querySelectorAll("[data-prd-diagram-edge]")).toHaveLength(6);
    const safetyRows = rendered.container.querySelectorAll("[data-prd-safety-row]");
    expect(safetyRows).toHaveLength(prdSafetyBaselineItems.length);
    expect(screen.getByText("范围")).not.toBeNull();
    expect(safetyRows[0]?.textContent).toContain(prdSafetyBaselineItems[0].requirement);
    expect(safetyRows[20]?.textContent).toContain(prdSafetyBaselineItems[20].requirement);
    expect(safetyRows[20]?.textContent).toContain("完整性校验通过");
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
    expect(screen.getByRole("textbox", { name: "PRD 编辑器" }).closest(".nowheel"))
      .not.toBeNull();
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

function prdDocument(): PrdDocumentV1 {
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
  }])) as unknown as PrdDocumentV1["sections"];
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

function prdV2Document(): PrdDocumentV2 {
  const text = (value: string): PrdInline[] => [{ type: "text", text: value, marks: [] }];
  const paragraph = (id: string, value: string): PrdBlock => ({
    id,
    type: "paragraph",
    content: text(value),
  });
  const diagramNodes = (prefix: string) => [
    { id: `${prefix}-node-1`, label: "用户入口", group: "用户端" },
    { id: `${prefix}-node-2`, label: "业务服务", group: "服务层" },
    { id: `${prefix}-node-3`, label: "风控服务", group: "能力层" },
    { id: `${prefix}-node-4`, label: "结果页面", group: "用户端" },
  ];
  const diagramEdges = (prefix: string) => [
    { id: `${prefix}-edge-1`, from: `${prefix}-node-1`, to: `${prefix}-node-2`, label: "提交请求" },
    { id: `${prefix}-edge-2`, from: `${prefix}-node-2`, to: `${prefix}-node-3`, label: "风险校验" },
    { id: `${prefix}-edge-3`, from: `${prefix}-node-3`, to: `${prefix}-node-4`, label: "返回结果" },
  ];
  return {
    protocol: "workbench.prd.v2",
    documentId: "prd-doc-v2",
    title: "支付体验优化需求说明书",
    revision: {
      number: 2,
      status: "inReview",
      summary: "补充业务规则与安全自查结果",
      changedAt: "2026-07-23T08:00:00.000Z",
      changedById: null,
    },
    cover: {
      workOrderName: "支付体验优化",
      title: "支付体验优化需求说明书",
    },
    versionHistory: [{
      status: "评审中",
      author: "产品经理",
      participants: ["产品经理", "研发负责人"],
      startDate: "2026-07-21",
      endDate: "2026-07-23",
      notes: "补充完整需求说明",
    }],
    tableOfContents: {
      title: "目 录",
      entries: [...prdTableOfContentsEntries],
    },
    assumptions: [],
    citations: [],
    sections: {
      introduction: {
        title: "1 引言",
        background: {
          title: "1.1项目背景",
          blocks: [paragraph("v2-background", "现有支付流程步骤较多，需要降低用户操作成本。")],
        },
        scope: {
          title: "1.2文档范围",
          blocks: [{
            id: "v2-scope",
            type: "bulletList",
            items: [{ id: "v2-scope-item", content: text("覆盖支付确认、风险校验和结果反馈。") }],
          }],
        },
        usageScenarios: {
          title: "1.3使用场景（必填）",
          blocks: [paragraph("v2-scenarios", "用户在多个渠道完成订单支付。")],
          channelTable: {
            title: "活动投放渠道",
            rows: [
              { sequence: 1, channel: "inApp", enabled: true },
              { sequence: 2, channel: "wapH5", enabled: true },
              { sequence: 3, channel: "miniProgram", enabled: false },
            ],
          },
        },
      },
      businessRequirements: {
        title: "2 业务需求",
        summary: text("通过统一流程提升支付成功率并降低异常处理成本。"),
        pageLinks: {
          title: "2.1页面链接",
          blocks: [paragraph("v2-page-links", "支付确认页：/checkout；支付结果页：/result。")],
        },
        coreRules: {
          title: "2.2 核心业务规则/功能说明",
          blocks: [{
            id: "v2-rule-table",
            type: "table",
            columns: [
              { id: "rule-name", label: "规则" },
              { id: "rule-detail", label: "说明" },
            ],
            rows: [{
              id: "rule-row-1",
              cells: [
                { columnId: "rule-name", content: text("重复提交") },
                { columnId: "rule-detail", content: text("同一订单只允许一个有效支付请求。") },
              ],
            }],
          }],
        },
        flowAndPages: {
          title: "2.3 核心流程/状态/页面要求",
          blocks: [paragraph("v2-flow-pages", "页面必须覆盖处理中、成功与失败状态。")],
          diagrams: [
            {
              id: "product-flow",
              kind: "productFlow",
              title: "图1 产品流程图",
              description: "展示用户发起支付、系统完成风险校验并返回支付结果的完整流程。",
              nodes: diagramNodes("flow"),
              edges: diagramEdges("flow"),
            },
            {
              id: "product-architecture",
              kind: "productArchitecture",
              title: "图2 产品架构图",
              description: "展示用户端、业务服务与风险能力之间稳定清晰的调用关系。",
              nodes: diagramNodes("architecture"),
              edges: diagramEdges("architecture"),
            },
          ],
        },
        acceptanceCriteria: {
          title: "2.4 验收标准",
          blocks: [{
            id: "v2-acceptance-table",
            type: "table",
            columns: [
              { id: "acceptance-sequence", label: "序号" },
              { id: "acceptance-item", label: "验收项" },
              { id: "acceptance-standard", label: "验收标准" },
            ],
            rows: [
              ["1", "页面可见性", "有支付权限的用户进入确认页后，可以看到订单金额、支付方式和提交操作。"],
              ["2", "业务规则", "同一订单连续点击提交时，系统只创建一个有效支付请求并禁用重复操作。"],
              ["3", "权限控制", "无支付权限的用户不能发起请求，页面明确提示无权限且不改变订单状态。"],
              ["4", "状态反馈", "支付处理中、成功和失败状态按真实结果展示，刷新页面后状态保持一致。"],
              ["5", "异常恢复", "支付失败时页面保留订单信息、展示失败原因，并提供可执行的重新支付操作。"],
            ].map(([sequence, item, standard]) => ({
              id: `acceptance-row-${sequence}`,
              cells: [
                { columnId: "acceptance-sequence", content: text(sequence!) },
                { columnId: "acceptance-item", content: text(item!) },
                { columnId: "acceptance-standard", content: text(standard!) },
              ],
            })),
          }],
        },
      },
      degradation: {
        title: "3 业务降级方案（必填）",
        applicable: false,
        content: text("不涉及"),
      },
      safetyBaseline: {
        title: "4 需求安全基线要求（必填）",
        intro: prdSafetyBaselineIntro,
        rows: prdSafetyBaselineItems.map((item, index) => ({
          sequence: item.sequence,
          applicability: index < 3 ? "是" : "不涉及",
          remarks: index < 3
            ? "支付页面已按该项要求补充访问控制、数据处理边界和验收标准。"
            : index === 20
              ? "完整性校验通过"
              : null,
        })),
      },
    },
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
