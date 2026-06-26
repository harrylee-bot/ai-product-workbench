export type Phase1PrdPreview = {
  id?: string;
  title: string;
  sections: Array<{
    id: string;
    title: string;
    content: string;
    type?: string;
    sourcePaths?: string[];
    sourceStatePaths?: string[];
    blocks?: Array<{
      id: string;
      type: "paragraph" | "quote" | "warning" | "info";
      content: string;
      sourcePaths?: string[];
    }>;
  }>;
};

export type Phase1PrototypePreview = {
  id?: string;
  title: string;
  html: string;
  entryFilePath?: string;
};

export type JsonCanvasNode = {
  id: string;
  type: "text" | "group" | "file" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: string;
  color?: string;
};

export type JsonCanvasEdge = {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
  toEnd?: "none" | "arrow";
  label?: string;
  color?: string;
};

export type DocumentCanvasPreview = {
  documentId: string;
  projectId: string;
  title: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  canvas: {
    nodes: JsonCanvasNode[];
    edges: JsonCanvasEdge[];
  };
  stats: {
    sectionCount: number;
    blockCount: number;
    nodeCount: number;
    edgeCount: number;
  };
  generatedAt: string;
};

export type PreviewMode = "prd" | "canvas" | "prototype";
export type PrototypeCanvasMode = "browse" | "select";
export type PrototypeLocalAction = "copy_generate" | "visual_refine" | "layout_adjust" | "interaction_fill";

export type CanvasRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PrototypeCanvasSelection = CanvasRect & {
  id: string;
  kind: "point" | "box";
  label: string;
  componentId?: string;
  pageId?: string;
  componentName?: string;
  createdAt: number;
};

export type PrototypeLocalGeneration = {
  title: string;
  changes: string[];
};

export type PrototypeComponentNode = {
  id: string;
  name: string;
  type: string;
  detail: string;
  depth: number;
};
