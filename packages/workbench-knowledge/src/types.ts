import type {
  KnowledgeStorageAssetDeclaration,
  KnowledgeStorageDirectoryReference,
} from "./storage-asset-policy.mjs";

export type KnowledgeRoute = "production" | "source_lookup" | "excluded" | "quarantine";

export type KnowledgeIssueSeverity = "warning" | "error";

export type KnowledgeIssueCode =
  | "INVALID_SOURCE_PATH"
  | "INVALID_SOURCE_ENCODING"
  | "DUPLICATE_SOURCE_PATH"
  | "FRONTMATTER_MISSING"
  | "FRONTMATTER_YAML_INVALID"
  | "FRONTMATTER_INVALID"
  | "FRONTMATTER_STATUS_UNKNOWN"
  | "ABSOLUTE_INTERNAL_REFERENCE"
  | "INVALID_INTERNAL_REFERENCE"
  | "UNRESOLVED_INTERNAL_REFERENCE"
  | "AMBIGUOUS_INTERNAL_REFERENCE"
  | "UNRESOLVED_HEADING_REFERENCE";

export interface KnowledgeIssue {
  readonly code: KnowledgeIssueCode;
  readonly severity: KnowledgeIssueSeverity;
  readonly sourceLocator: string;
  readonly message: string;
  readonly reference?: string;
}

export interface VaultSourceInput {
  /** POSIX-style path relative to the configured vault root. */
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface VaultStorageAssetInput extends KnowledgeStorageAssetDeclaration {
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly symbolicLink: boolean;
}

export interface KnowledgeFrontmatter {
  readonly title: string;
  readonly description?: string;
  readonly date?: string;
  readonly status: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly source?: string;
  readonly extra: Readonly<Record<string, JsonValue>>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type KnowledgeReferenceSyntax = "wikilink" | "markdown_link" | "markdown_image";
export type KnowledgeReferenceKind = "internal_document" | "internal_asset" | "external";
export type KnowledgeReferenceResolution = "resolved" | "unresolved" | "ambiguous" | "not_applicable";

export interface KnowledgeReference {
  readonly syntax: KnowledgeReferenceSyntax;
  readonly kind: KnowledgeReferenceKind;
  readonly rawTarget: string;
  readonly label?: string;
  readonly fragment?: string;
  readonly resolution: KnowledgeReferenceResolution;
  readonly resolvedLocator?: string;
}

export type KnowledgeBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "code"
  | "blockquote"
  | "html"
  | "definition"
  | "thematic_break"
  | "other";

export interface KnowledgeBlock {
  readonly sequence: number;
  readonly kind: KnowledgeBlockKind;
  readonly headingPath: readonly string[];
  readonly markdown: string;
  readonly retrievalText: string;
  /** Top-level blocks are indivisible unless they individually exceed the token budget. */
  readonly atomic: true;
}

export interface ParsedKnowledgeDocument {
  readonly sourcePath: string;
  readonly sourceLocator: string;
  readonly sourceChecksum: string;
  readonly normalizedMarkdown: string;
  readonly title: string;
  readonly frontmatter?: KnowledgeFrontmatter;
  readonly route: KnowledgeRoute;
  readonly headings: readonly string[];
  readonly blocks: readonly KnowledgeBlock[];
  readonly references: readonly KnowledgeReference[];
  readonly issues: readonly KnowledgeIssue[];
}

export interface KnowledgeChunk {
  readonly id: string;
  readonly checksum: string;
  readonly sourceLocator: string;
  readonly sequence: number;
  readonly headingPath: readonly string[];
  readonly blockSequences: readonly number[];
  readonly content: string;
  readonly tokenCount: number;
}

export interface RetrievalProjection {
  readonly chunkId: string;
  readonly content: string;
  readonly lexemes: readonly string[];
  readonly searchText: string;
}

export interface KnowledgeReleaseDocumentManifest {
  readonly sourcePath: string;
  readonly sourceLocator: string;
  readonly sourceChecksum: string;
  readonly title: string;
  readonly route: KnowledgeRoute;
  readonly status?: string;
  readonly tags: readonly string[];
  readonly references: readonly KnowledgeReference[];
  readonly chunks: readonly {
    readonly id: string;
    readonly checksum: string;
    readonly sequence: number;
    readonly headingPath: readonly string[];
    readonly tokenCount: number;
  }[];
  readonly issues: readonly KnowledgeIssue[];
}

export type KnowledgeReleaseAssetManifest = VaultStorageAssetInput;

export interface KnowledgeReleaseProfile {
  readonly tokenizer: {
    readonly id: string;
    readonly version: string;
    readonly maximumTokens: number;
  };
  /** Immutable retrieval behavior used to build and serve this release. */
  readonly retrieval: {
    readonly id: string;
    readonly specSha256: string;
  };
  readonly segmenter?: {
    readonly id: string;
    readonly version: string;
    readonly dictionaryChecksum?: string;
    readonly stopwordsChecksum?: string;
  };
  readonly embedding?: {
    readonly id: string;
    readonly specSha256: string;
  };
}

export interface KnowledgeReleaseManifest {
  readonly schema: "workbench.knowledge-release.v1";
  readonly releaseKey: string;
  readonly releaseVersion: number;
  readonly vaultRoot: string;
  readonly algorithms: {
    readonly sourceNormalization: "utf8-nfc-lf-v1";
    readonly markdown: "unified-remark-gfm-wikilink-v1";
    readonly routing: "vault-path-status-v1";
    readonly chunking: "heading-atomic-greedy-v1";
    readonly projection: "mdast-retrieval-v1";
    readonly assetClosure: "storage-explicit-reference-v1";
    readonly canonicalJson: "rfc8785-jcs";
    readonly checksum: "sha256";
  };
  readonly profile: KnowledgeReleaseProfile;
  readonly documents: readonly KnowledgeReleaseDocumentManifest[];
  readonly assetClosure: {
    readonly policy: {
      readonly allowedCategories: readonly ["imports", "source-assets"];
      readonly directoryReferencesExpand: false;
      readonly declaredIntegrityRequiredToMatch: true;
    };
    readonly directoryReferences: readonly KnowledgeStorageDirectoryReference[];
    readonly referencedAssetCount: number;
    readonly referencedBytes: number;
    readonly assets: readonly KnowledgeReleaseAssetManifest[];
  };
  readonly issues: readonly KnowledgeIssue[];
}

export interface KnowledgeReleaseBundle {
  readonly manifest: KnowledgeReleaseManifest;
  readonly manifestCanonicalJson: string;
  readonly manifestChecksum: string;
  readonly documents: readonly ParsedKnowledgeDocument[];
  readonly chunks: readonly KnowledgeChunk[];
  readonly projections: readonly RetrievalProjection[];
}
