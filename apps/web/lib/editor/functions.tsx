"use client";

import {
  defaultMarkdownSerializer,
  MarkdownSerializer,
} from "prosemirror-markdown";
import { DOMParser, type Node } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { renderToString } from "react-dom/server";

import { MessageResponse } from "@/components/ai-elements/message";

import { documentSchema } from "./config";
import type { UISuggestion } from "./suggestions";

const documentMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    table(state, node) {
      const rows = tableRowsToMarkdown(node);
      if (rows.length === 0) {
        state.closeBlock(node);
        return;
      }

      const columnCount = Math.max(...rows.map((row) => row.length));
      const normalizedRows = rows.map((row) =>
        Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
      );
      const [header, ...bodyRows] = normalizedRows;

      state.write(markdownTableRow(header));
      state.write(`\n${markdownTableRow(header.map(() => "---"))}`);
      for (const row of bodyRows) {
        state.write(`\n${markdownTableRow(row)}`);
      }
      state.closeBlock(node);
    },
    table_row() {
      // Serialized by the parent table node.
    },
    table_cell() {
      // Serialized by the parent table node.
    },
    table_header() {
      // Serialized by the parent table node.
    },
  },
  defaultMarkdownSerializer.marks,
);

export const buildDocumentFromContent = (content: string) => {
  const parser = DOMParser.fromSchema(documentSchema);
  const stringFromMarkdown = renderToString(
    <MessageResponse>{content}</MessageResponse>
  );
  const tempContainer = document.createElement("div");
  tempContainer.innerHTML = stringFromMarkdown;
  return parser.parse(tempContainer);
};

export const buildContentFromDocument = (document: Node) => {
  return documentMarkdownSerializer.serialize(document);
};

export const createDecorations = (
  suggestions: UISuggestion[],
  _view: EditorView
) => {
  const decorations: Decoration[] = [];

  for (const suggestion of suggestions) {
    decorations.push(
      Decoration.inline(
        suggestion.selectionStart,
        suggestion.selectionEnd,
        {
          class: "suggestion-highlight",
          "data-suggestion-id": suggestion.id,
        },
        {
          suggestionId: suggestion.id,
          type: "highlight",
        }
      )
    );
  }

  return DecorationSet.create(_view.state.doc, decorations);
};

function tableRowsToMarkdown(table: Node) {
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(escapeMarkdownTableCell(cell.textContent));
    });
    if (cells.length) {
      rows.push(cells);
    }
  });
  return rows;
}

function markdownTableRow(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
}

function escapeMarkdownTableCell(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}
