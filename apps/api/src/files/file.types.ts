import {
  FileChunkSourceType,
  FileParserType,
  ParseResultStatus,
} from "@prisma/client";

export type ParsedSection = {
  id: string;
  title?: string;
  level?: number;
  content: string;
  order: number;
};

export type ParsedPage = {
  id: string;
  title?: string;
  pageNumber?: number;
  content?: string;
  filePath?: string;
  previewImagePath?: string;
  visualContextId?: string;
  outboundLinks?: Array<{
    label?: string;
    targetPath: string;
  }>;
};

export type ParsedImage = {
  id: string;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
  storagePath?: string;
  previewUrl?: string;
  description?: string;
};

export type VisualAttachmentContext = {
  id: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
  storagePath: string;
  previewUrl?: string;
  purpose:
    | "product_screenshot"
    | "prototype_reference"
    | "prototype_snapshot"
    | "document_page_image"
    | "axure_page_preview"
    | "unknown";
  modelInput: {
    type: "image";
    imageUrl?: string;
    fileRef?: string;
  };
  note?: string;
};

export type AxureParseInfo = {
  isAxureHtmlExport: boolean;
  entryFile?: string;
  pageCount?: number;
  pages: Array<{
    title: string;
    filePath: string;
    previewImagePath?: string;
  }>;
  assetCount?: number;
  notes?: string[];
};

export type PrototypeConversionPlan = {
  source: "rp";
  status: "queued";
  stage: "queued";
  sourceFilePath: string;
  expectedOutputKind: "axure_html";
  converter: {
    requiredRuntime: "macos_axure_rp";
    commandConfigured: boolean;
  };
};

export type ParsedChunk = {
  chunkIndex: number;
  content: string;
  tokenEstimate?: number;
  sourceType: FileChunkSourceType;
  sourceRef?: string;
};

export type ParserOutput = {
  status: ParseResultStatus;
  parserType: FileParserType;
  title?: string;
  summary?: string;
  extractedText?: string;
  wordCount?: number;
  sections?: ParsedSection[];
  pages?: ParsedPage[];
  images?: ParsedImage[];
  visualContexts?: VisualAttachmentContext[];
  axureInfo?: AxureParseInfo;
  prototypeConversion?: PrototypeConversionPlan;
  errorMessage?: string;
  warnings?: string[];
  chunks?: ParsedChunk[];
};

export type AttachmentSummary = {
  fileId: string;
  fileName: string;
  fileType: string;
  size: number;
  parseStatus: string;
  parserType?: string;
  summary?: string;
  extractedTextPreview?: string;
  sections?: Array<{
    title?: string;
    contentPreview: string;
  }>;
  visualContexts?: VisualAttachmentContext[];
  axureInfo?: AxureParseInfo;
  prototypeConversion?: PrototypeConversionPlan | Record<string, unknown>;
  prototypeConversionJob?: Record<string, unknown>;
  warnings?: string[];
};

export type RuntimeAttachmentFile = {
  fileId: string;
  fileName: string;
  fileType: string;
  mimeType: string;
  size: number;
  storagePath: string;
};
