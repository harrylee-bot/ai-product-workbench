// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { browserRuntimeSource } from "../src/runtime-source";

const unsafeUrls = [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///tmp/unsafe",
  "blob:https://example.com/unsafe",
  "custom-scheme:unsafe",
];

const safeUrls = [
  "https://example.com/prototype",
  "mailto:designer@example.com?subject=Review",
  "tel:+8613800138000",
];

describe("exported Prototype runtime URL security", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps the navigation guard in the generated runtime snapshot", () => {
    const block = browserRuntimeSource.match(
      /if \(action\.kind === "openUrl"\) \{[\s\S]*?\n      \}/,
    )?.[0];
    expect(block).toMatchInlineSnapshot(`
      "if (action.kind === \"openUrl\") {
              if (!isSafePrototypeOpenUrl(action.url)) return;
              if (action.target === \"newWindow\") window.open(action.url, \"_blank\", \"noopener,noreferrer\");
              else window.location.assign(action.url);
              return;
            }"
    `);
  });

  it.each(safeUrls)("allows the supported URL %s in the standalone runtime", async (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    installRuntime(url);

    screenButton().click();
    await flushRuntimeActions();

    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });

  it.each(unsafeUrls)("fails closed for the URL %s in the standalone runtime", async (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    installRuntime(url);

    screenButton().click();
    await flushRuntimeActions();

    expect(open).not.toHaveBeenCalled();
  });

  it("fails closed without throwing for a non-string runtime URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    installRuntime({ injected: true });

    expect(() => screenButton().click()).not.toThrow();
    await flushRuntimeActions();
    expect(open).not.toHaveBeenCalled();
  });

  it("resets only variables owned by the selected sibling form", async () => {
    installSiblingFormRuntime();
    const primary = document.querySelector<HTMLInputElement>('[data-wb-node="input-primary"]')!;
    const secondary = document.querySelector<HTMLInputElement>('[data-wb-node="input-secondary"]')!;
    primary.value = "primary-changed";
    primary.dispatchEvent(new Event("input", { bubbles: true }));
    secondary.value = "secondary-changed";
    secondary.dispatchEvent(new Event("input", { bubbles: true }));

    document.querySelector<HTMLButtonElement>('[data-reset-form="primary"]')!.click();
    await flushRuntimeActions();

    expect(primary.value).toBe("primary-initial");
    expect(secondary.value).toBe("secondary-changed");
  });
});

function installRuntime(url: unknown) {
  const data = document.createElement("script");
  data.id = "workbench-export-data";
  data.type = "application/json";
  data.textContent = JSON.stringify({
    prototypes: [{
      id: "prototype-1",
      documentId: "prototype-document-1",
      initialScreenId: "screen-1",
      screens: [{ id: "screen-1", initialStateId: null }],
      variables: [],
      states: [],
      motions: [],
      bindings: [],
      actions: [{
        id: "action-open",
        nodeId: "button-open",
        event: "click",
        kind: "openUrl",
        url,
        target: "newWindow",
      }],
    }],
  });
  const root = document.createElement("div");
  root.id = "workbench-export-root";
  root.innerHTML = [
    '<div data-wb-prototype="prototype-1">',
    '<section data-wb-screen="screen-1">',
    '<button data-wb-node="button-open" type="button">Open</button>',
    "</section>",
    "</div>",
  ].join("");
  document.body.append(data, root);

  Function(browserRuntimeSource)();
}

function flushRuntimeActions() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function installSiblingFormRuntime() {
  const data = document.createElement("script");
  data.id = "workbench-export-data";
  data.type = "application/json";
  data.textContent = JSON.stringify({
    prototypes: [{
      id: "prototype-forms",
      documentId: "prototype-form-document",
      initialScreenId: "screen-forms",
      screens: [{ id: "screen-forms", initialStateId: null }],
      variables: [
        { path: "form.primary", initialValue: "primary-initial" },
        { path: "form.secondary", initialValue: "secondary-initial" },
      ],
      states: [],
      motions: [],
      actions: [],
      bindings: [
        { id: "binding-primary", nodeId: "input-primary", property: "value", source: { kind: "variable", path: "form.primary" } },
        { id: "binding-secondary", nodeId: "input-secondary", property: "value", source: { kind: "variable", path: "form.secondary" } },
      ],
    }],
  });
  const root = document.createElement("div");
  root.id = "workbench-export-root";
  root.innerHTML = [
    '<div data-wb-prototype="prototype-forms">',
    '<section data-wb-screen="screen-forms">',
    '<form data-wb-node="form-primary"><input data-wb-node="input-primary" name="primary"><button data-reset-form="primary" type="reset">Reset</button></form>',
    '<form data-wb-node="form-secondary"><input data-wb-node="input-secondary" name="secondary"></form>',
    "</section>",
    "</div>",
  ].join("");
  document.body.append(data, root);
  Function(browserRuntimeSource)();
}

function screenButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('[data-wb-node="button-open"]');
  if (!button) throw new Error("runtime button was not installed");
  return button;
}
