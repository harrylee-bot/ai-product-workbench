import { textblockTypeInputRule } from "prosemirror-inputrules";
import { Schema, type NodeSpec } from "prosemirror-model";
import { schema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { MutableRefObject } from "react";

import { buildContentFromDocument } from "./functions";

const tableNodes: Record<string, NodeSpec> = {
  table: {
    content: "table_row+",
    group: "block",
    isolating: true,
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["table", ["tbody", 0]],
  },
  table_row: {
    content: "(table_cell | table_header)*",
    parseDOM: [{ tag: "tr" }],
    toDOM: () => ["tr", 0],
  },
  table_cell: {
    content: "block+",
    isolating: true,
    parseDOM: [{ tag: "td" }],
    toDOM: () => ["td", 0],
  },
  table_header: {
    content: "block+",
    isolating: true,
    parseDOM: [{ tag: "th" }],
    toDOM: () => ["th", 0],
  },
};

export const documentSchema = new Schema({
  nodes: addListNodes(schema.spec.nodes, "paragraph block*", "block").append(
    tableNodes,
  ),
  marks: schema.spec.marks,
});

export function headingRule(level: number) {
  return textblockTypeInputRule(
    new RegExp(`^(#{1,${level}})\\s$`),
    documentSchema.nodes.heading,
    () => ({ level })
  );
}

export const handleTransaction = ({
  transaction,
  editorRef,
  onSaveContent,
}: {
  transaction: Transaction;
  editorRef: MutableRefObject<EditorView | null>;
  onSaveContent: (updatedContent: string, debounce: boolean) => void;
}) => {
  if (!editorRef?.current) {
    return;
  }

  const newState = editorRef.current.state.apply(transaction);
  editorRef.current.updateState(newState);

  if (transaction.docChanged && !transaction.getMeta("no-save")) {
    const updatedContent = buildContentFromDocument(newState.doc);

    if (transaction.getMeta("no-debounce")) {
      onSaveContent(updatedContent, false);
    } else {
      onSaveContent(updatedContent, true);
    }
  }
};
