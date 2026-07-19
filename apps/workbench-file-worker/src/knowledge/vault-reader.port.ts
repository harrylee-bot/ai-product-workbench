import type {
  KnowledgeStorageDirectoryReference,
  VaultSourceInput,
  VaultStorageAssetInput,
} from "@workbench/workbench-knowledge";

export interface KnowledgeVaultSnapshot {
  readonly sources: readonly VaultSourceInput[];
  readonly assets: readonly VaultStorageAssetInput[];
  readonly storageDirectoryReferences: readonly KnowledgeStorageDirectoryReference[];
}

export interface KnowledgeVaultReaderPort {
  readSnapshot(signal?: AbortSignal): Promise<KnowledgeVaultSnapshot>;
}
