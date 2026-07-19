export type KnowledgeStorageReferenceKind = "inline-code" | "markdown-link" | "frontmatter" | "bare";

export interface KnowledgeStorageReferenceSource {
  readonly file: string;
  readonly line: number;
  readonly kind: KnowledgeStorageReferenceKind;
}

export interface KnowledgeStorageIntegritySource {
  readonly file: string;
  readonly line: number;
  readonly kind: "sha256" | "byteSize";
  readonly value: string | number;
}

export interface KnowledgeStorageAssetDeclaration {
  readonly path: string;
  readonly references: readonly KnowledgeStorageReferenceSource[];
  readonly declaredIntegrity: {
    readonly sha256: readonly string[];
    readonly byteSize: readonly number[];
    readonly sources: readonly KnowledgeStorageIntegritySource[];
  };
}

export interface KnowledgeStoragePolicyIssue {
  readonly code:
    | "INVALID_STORAGE_REFERENCE"
    | "STORAGE_INTEGRITY_INVALID"
    | "STORAGE_INTEGRITY_AMBIGUOUS"
    | "STORAGE_INTEGRITY_CONFLICT"
    | "STORAGE_CHECKSUM_MISMATCH"
    | "STORAGE_BYTE_SIZE_MISMATCH";
  readonly file: string;
  readonly line: number;
  readonly path?: string;
  readonly detail: string;
}

export interface KnowledgeStorageDirectoryReference extends KnowledgeStorageReferenceSource {
  readonly raw: string;
  readonly path: string;
}

export interface KnowledgeStorageRejectedReference extends KnowledgeStorageReferenceSource {
  readonly raw: string;
  readonly reason: string;
}

export const KNOWLEDGE_STORAGE_ALLOWED_CATEGORIES: readonly ["imports", "source-assets"];

export function collectKnowledgeStorageDeclarations(documents: readonly {
  readonly relativePath: string;
  readonly raw: string;
  readonly header?: string;
}[]): {
  readonly assets: readonly KnowledgeStorageAssetDeclaration[];
  readonly directoryReferences: readonly KnowledgeStorageDirectoryReference[];
  readonly rejectedReferences: readonly KnowledgeStorageRejectedReference[];
  readonly issues: readonly KnowledgeStoragePolicyIssue[];
};

export function normalizeKnowledgeStorageReference(raw: string):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly logicalPath: string; readonly directory: boolean };

export function validateKnowledgeStorageIntegrity(
  asset: KnowledgeStorageAssetDeclaration,
  actual: { readonly byteSize: number; readonly sha256: string },
): readonly KnowledgeStoragePolicyIssue[];

export function knowledgeStorageMediaType(filePath: string): string;
