import {
  Extension,
  Node,
  mergeAttributes,
  type Extensions,
} from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import UniqueID from "@tiptap/extension-unique-id";
import StarterKit from "@tiptap/starter-kit";

const PrdFieldAttributes = Extension.create({
  name: "workbenchPrdFieldAttributes",
  addGlobalAttributes() {
    return [{
      types: ["heading", "paragraph"],
      attributes: {
        prdPath: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-prd-path"),
          renderHTML: (attributes) => attributes.prdPath
            ? { "data-prd-path": attributes.prdPath }
            : {},
        },
        prdValueKind: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-prd-value-kind"),
          renderHTML: (attributes) => attributes.prdValueKind
            ? { "data-prd-value-kind": attributes.prdValueKind }
            : {},
        },
        prdRole: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-prd-role"),
          renderHTML: (attributes) => attributes.prdRole
            ? { "data-prd-role": attributes.prdRole }
            : {},
        },
      },
    }];
  },
});

const PrdSection = Node.create({
  name: "prdSection",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      sectionKey: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-prd-section"),
        renderHTML: (attributes) => ({ "data-prd-section": attributes.sectionKey }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "section[data-prd-section]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      mergeAttributes(HTMLAttributes, {
        class: "mb-[46px] text-[22px] leading-[36px]",
      }),
      0,
    ];
  },
});

const PrdCard = Node.create({
  name: "prdCard",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      kind: {
        default: "default",
        parseHTML: (element) => element.getAttribute("data-prd-card") ?? "default",
        renderHTML: (attributes) => ({ "data-prd-card": attributes.kind }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-prd-card]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    const className = node.attrs.kind === "risk"
      ? "rounded-[8px] border border-[#e6a05a]/30 bg-[#e6a05a]/[0.06] p-[18px]"
      : node.attrs.kind === "callout"
        ? "rounded-[8px] border border-[#7467f6]/35 bg-[#7467f6]/[0.08] p-[18px]"
        : "rounded-[8px] border border-white/[0.10] bg-white/[0.04] p-[18px]";
    return ["div", mergeAttributes(HTMLAttributes, { class: className }), 0];
  },
});

const PrdLabel = Node.create({
  name: "prdLabel",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-prd-label") ?? "",
        renderHTML: (attributes) => ({ "data-prd-label": attributes.text }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-prd-label]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "font-semibold text-[#f1f3f4]",
        contenteditable: "false",
      }),
      node.attrs.text,
    ];
  },
});

const PrdCitation = Node.create({
  name: "prdCitation",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      citationId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-citation-id"),
        renderHTML: (attributes) => ({ "data-citation-id": attributes.citationId }),
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-citation-label"),
        renderHTML: (attributes) => attributes.label
          ? { "data-citation-label": attributes.label }
          : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-citation-id]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "rounded-[4px] bg-[#7467f6]/15 px-[4px] text-[#cfc9ff]",
        contenteditable: "false",
      }),
      node.attrs.label ?? `[${node.attrs.citationId}]`,
    ];
  },
});

const PrdReference = Node.create({
  name: "prdReference",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      targetType: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-reference-type"),
        renderHTML: (attributes) => ({ "data-reference-type": attributes.targetType }),
      },
      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-reference-id"),
        renderHTML: (attributes) => ({ "data-reference-id": attributes.targetId }),
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-reference-label"),
        renderHTML: (attributes) => attributes.label
          ? { "data-reference-label": attributes.label }
          : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-reference-id]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "rounded-[4px] bg-white/[0.06] px-[4px] text-[#c7cad0]",
        contenteditable: "false",
      }),
      node.attrs.label ?? node.attrs.targetId,
    ];
  },
});

export const workbenchPrdExtensions: Extensions = [
  StarterKit.configure({
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    link: false,
  }),
  Link.configure({
    autolink: true,
    linkOnPaste: true,
    openOnClick: false,
    protocols: ["http", "https", "mailto"],
  }),
  TableKit.configure({
    table: { resizable: false },
  }),
  UniqueID.configure({
    attributeName: "dataId",
    types: ["heading", "paragraph", "bulletList", "orderedList", "table", "prdCard", "prdSection"],
    updateDocument: false,
  }),
  PrdFieldAttributes,
  PrdSection,
  PrdCard,
  PrdLabel,
  PrdCitation,
  PrdReference,
];
