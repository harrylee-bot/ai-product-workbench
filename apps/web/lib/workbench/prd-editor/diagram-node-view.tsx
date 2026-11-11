"use client";

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { prdTemplateDiagramSchema } from "@workbench/workbench-contracts";
import { WorkbenchPrdDiagramCanvas } from "../../../components/workbench/workbench-prd-diagram-canvas";

export function PrdDiagramNodeView({ node }: NodeViewProps) {
  const diagram = prdTemplateDiagramSchema.safeParse(node.attrs.diagram);
  if (!diagram.success) return <NodeViewWrapper contentEditable={false}>图示内容无效</NodeViewWrapper>;
  return (
    <NodeViewWrapper contentEditable={false} data-prd-inline-diagram>
      <figure className="my-[24px]">
        <figcaption className="text-[16px] font-semibold">{diagram.data.title}</figcaption>
        <p className="mt-[6px] text-[14px] leading-[23px]">{diagram.data.description}</p>
        <WorkbenchPrdDiagramCanvas diagram={diagram.data} />
      </figure>
    </NodeViewWrapper>
  );
}
