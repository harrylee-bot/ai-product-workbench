import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  collectKnowledgeStorageDeclarations,
  knowledgeStorageMediaType,
  validateKnowledgeStorageIntegrity,
  type KnowledgeStorageAssetDeclaration,
  type KnowledgeStorageDirectoryReference,
  type VaultSourceInput,
  type VaultStorageAssetInput,
} from "@workbench/workbench-knowledge";
import { RetryableKnowledgeBuildError, TerminalKnowledgeBuildError } from "./knowledge.errors.js";
import type { KnowledgeVaultReaderPort, KnowledgeVaultSnapshot } from "./vault-reader.port.js";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
};

type DiscoveredMarkdown = {
  absolutePath: string;
  sourcePath: string;
  identity: FileIdentity;
};

type DiscoveredAsset = {
  declaration: KnowledgeStorageAssetDeclaration;
  absolutePath: string;
  canonicalPath: string;
  identity: FileIdentity;
  symbolicLink: boolean;
};

export class SafeKnowledgeVaultReader implements KnowledgeVaultReaderPort {
  private readonly rootDirectory: string;
  private readonly storageDirectory: string;

  constructor(
    rootDirectory: string,
    storageDirectory: string,
    private readonly limits: {
      maximumFileBytes: number;
      maximumTotalBytes: number;
      maximumMarkdownFiles: number;
      maximumEntries: number;
      maximumAssetFileBytes: number;
      maximumAssetTotalBytes: number;
      maximumAssets: number;
    },
  ) {
    if (!rootDirectory.trim()) throw new TypeError("knowledge vault root must be non-empty");
    if (!storageDirectory.trim()) throw new TypeError("knowledge storage root must be non-empty");
    this.rootDirectory = resolve(rootDirectory);
    this.storageDirectory = resolve(storageDirectory);
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (limits.maximumFileBytes > limits.maximumTotalBytes) {
      throw new RangeError("maximumFileBytes cannot exceed maximumTotalBytes");
    }
    if (limits.maximumAssetFileBytes > limits.maximumAssetTotalBytes) {
      throw new RangeError("maximumAssetFileBytes cannot exceed maximumAssetTotalBytes");
    }
  }

  async readSnapshot(signal?: AbortSignal): Promise<KnowledgeVaultSnapshot> {
    try {
      throwIfAborted(signal);
      const realRoot = await validateRootDirectory(
        this.rootDirectory,
        "KNOWLEDGE_VAULT_ROOT_UNSAFE",
        "Knowledge vault root must be a real directory, not a symbolic link",
      );
      const realStorageRoot = await validateRootDirectory(
        this.storageDirectory,
        "KNOWLEDGE_STORAGE_ROOT_UNSAFE",
        "Knowledge storage root must be a real directory, not a symbolic link",
      );
      const firstMarkdown = await this.discoverMarkdown(realRoot, signal);
      if (firstMarkdown.length > this.limits.maximumMarkdownFiles) {
        throw new TerminalKnowledgeBuildError(
          "KNOWLEDGE_VAULT_FILE_COUNT_LIMIT_EXCEEDED",
          "Knowledge vault contains too many Markdown files",
        );
      }

      const sources: VaultSourceInput[] = [];
      let totalMarkdownBytes = 0;
      for (const file of firstMarkdown) {
        const bytes = await this.readStableMarkdown(file, realRoot, signal);
        totalMarkdownBytes = checkedTotal(
          totalMarkdownBytes,
          bytes.byteLength,
          this.limits.maximumTotalBytes,
          "KNOWLEDGE_VAULT_TOTAL_SIZE_LIMIT_EXCEEDED",
          "Knowledge vault Markdown exceeds its total byte limit",
        );
        sources.push({ path: file.sourcePath, content: bytes });
      }

      const declarations = collectKnowledgeStorageDeclarations(sources.map((source) => ({
        relativePath: source.path,
        raw: decodeMarkdown(source.content, source.path),
      })));
      const policyIssue = declarations.issues[0];
      if (policyIssue) {
        throw new TerminalKnowledgeBuildError(
          `KNOWLEDGE_${policyIssue.code}`,
          `Invalid Knowledge storage closure at ${policyIssue.file}:${policyIssue.line}: ${policyIssue.detail}`,
        );
      }
      if (declarations.assets.length > this.limits.maximumAssets) {
        throw new TerminalKnowledgeBuildError(
          "KNOWLEDGE_STORAGE_ASSET_COUNT_LIMIT_EXCEEDED",
          "Knowledge storage closure contains too many assets",
        );
      }

      for (const reference of declarations.directoryReferences) {
        await this.validateDirectoryReference(reference, realStorageRoot);
      }
      const firstAssets: DiscoveredAsset[] = [];
      for (const declaration of declarations.assets) {
        firstAssets.push(await this.discoverAsset(declaration, realStorageRoot));
      }
      let declaredAssetBytes = 0;
      for (const asset of firstAssets) {
        const byteSize = safeSize(asset.identity.size, "KNOWLEDGE_STORAGE_ASSET_SIZE_INVALID");
        if (byteSize > this.limits.maximumAssetFileBytes) {
          throw new TerminalKnowledgeBuildError(
            "KNOWLEDGE_STORAGE_ASSET_SIZE_LIMIT_EXCEEDED",
            `Knowledge storage asset exceeds its byte limit: ${asset.declaration.path}`,
          );
        }
        declaredAssetBytes = checkedTotal(
          declaredAssetBytes,
          byteSize,
          this.limits.maximumAssetTotalBytes,
          "KNOWLEDGE_STORAGE_TOTAL_SIZE_LIMIT_EXCEEDED",
          "Knowledge storage closure exceeds its total byte limit",
        );
      }

      const assets: VaultStorageAssetInput[] = [];
      for (const asset of firstAssets) {
        const verified = await this.hashStableAsset(asset, signal);
        const integrityIssue = validateKnowledgeStorageIntegrity(asset.declaration, verified)[0];
        if (integrityIssue) {
          throw new TerminalKnowledgeBuildError(
            `KNOWLEDGE_${integrityIssue.code}`,
            `Knowledge storage integrity check failed for ${asset.declaration.path}: ${integrityIssue.detail}`,
          );
        }
        assets.push({
          ...asset.declaration,
          mediaType: knowledgeStorageMediaType(asset.declaration.path),
          byteSize: verified.byteSize,
          sha256: verified.sha256,
          symbolicLink: asset.symbolicLink,
        });
      }

      const secondAssets: DiscoveredAsset[] = [];
      for (const declaration of declarations.assets) {
        secondAssets.push(await this.discoverAsset(declaration, realStorageRoot));
      }
      if (!sameAssetDiscovery(firstAssets, secondAssets)) {
        throw new RetryableKnowledgeBuildError(
          "KNOWLEDGE_STORAGE_CHANGED_DURING_READ",
          "Knowledge storage closure changed while its release snapshot was being read",
        );
      }
      const secondMarkdown = await this.discoverMarkdown(realRoot, signal);
      if (!sameMarkdownDiscovery(firstMarkdown, secondMarkdown)) {
        throw new RetryableKnowledgeBuildError(
          "KNOWLEDGE_VAULT_CHANGED_DURING_READ",
          "Knowledge vault changed while its release snapshot was being read",
        );
      }
      if (await realpath(this.rootDirectory) !== realRoot || await realpath(this.storageDirectory) !== realStorageRoot) {
        throw new RetryableKnowledgeBuildError(
          "KNOWLEDGE_SOURCE_ROOT_CHANGED_DURING_READ",
          "Knowledge source roots changed while their release snapshot was being read",
        );
      }
      return {
        sources,
        assets,
        storageDirectoryReferences: declarations.directoryReferences,
      };
    } catch (error) {
      if (error instanceof TerminalKnowledgeBuildError || error instanceof RetryableKnowledgeBuildError) throw error;
      if (signal?.aborted) throw abortError(signal);
      throw new RetryableKnowledgeBuildError(
        "KNOWLEDGE_VAULT_READ_FAILED",
        "Knowledge vault and its storage closure could not be read",
        { cause: error },
      );
    }
  }

  private async discoverMarkdown(realRoot: string, signal?: AbortSignal): Promise<readonly DiscoveredMarkdown[]> {
    const markdown: DiscoveredMarkdown[] = [];
    let entryCount = 0;

    const visitDirectory = async (directory: string): Promise<void> => {
      throwIfAborted(signal);
      const entries = (await readdir(directory)).sort(compareCodePoints);
      for (const name of entries) {
        throwIfAborted(signal);
        entryCount += 1;
        if (entryCount > this.limits.maximumEntries) {
          throw new TerminalKnowledgeBuildError(
            "KNOWLEDGE_VAULT_ENTRY_COUNT_LIMIT_EXCEEDED",
            "Knowledge vault contains too many filesystem entries",
          );
        }
        const path = resolve(directory, name);
        ensureWithinRoot(realRoot, path, "KNOWLEDGE_VAULT_PATH_ESCAPE");
        const stats = await lstat(path, { bigint: true });
        if (stats.isSymbolicLink()) {
          throw new TerminalKnowledgeBuildError(
            "KNOWLEDGE_VAULT_SYMLINK_FORBIDDEN",
            "Knowledge vault cannot contain symbolic links",
          );
        }
        if (stats.isDirectory()) {
          await visitDirectory(path);
          continue;
        }
        if (!stats.isFile()) {
          throw new TerminalKnowledgeBuildError(
            "KNOWLEDGE_VAULT_NON_REGULAR_ENTRY",
            "Knowledge vault cannot contain non-regular filesystem entries",
          );
        }
        if (!name.toLocaleLowerCase("en-US").endsWith(".md")) continue;
        const fileRealPath = await realpath(path);
        ensureWithinRoot(realRoot, fileRealPath, "KNOWLEDGE_VAULT_PATH_ESCAPE");
        markdown.push({
          absolutePath: path,
          sourcePath: toPosixPath(relative(realRoot, fileRealPath)),
          identity: identity(stats),
        });
      }
    };

    await visitDirectory(realRoot);
    return markdown.sort((left, right) => compareCodePoints(left.sourcePath, right.sourcePath));
  }

  private async readStableMarkdown(
    file: DiscoveredMarkdown,
    realRoot: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    throwIfAborted(signal);
    ensureWithinRoot(realRoot, file.absolutePath, "KNOWLEDGE_VAULT_PATH_ESCAPE");
    const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameIdentity(file.identity, identity(before))) {
        throw changedDuringRead("Knowledge vault file identity changed before it could be read");
      }
      const byteSize = safeSize(before.size, "KNOWLEDGE_VAULT_FILE_SIZE_INVALID");
      if (byteSize > this.limits.maximumFileBytes) {
        throw new TerminalKnowledgeBuildError(
          "KNOWLEDGE_VAULT_FILE_SIZE_LIMIT_EXCEEDED",
          "A Knowledge vault Markdown file exceeds its byte limit",
        );
      }
      const bytes = await handle.readFile();
      throwIfAborted(signal);
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(identity(before), identity(after)) || bytes.byteLength !== byteSize) {
        throw changedDuringRead("Knowledge vault file changed while it was being read");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async validateDirectoryReference(
    reference: KnowledgeStorageDirectoryReference,
    realStorageRoot: string,
  ): Promise<void> {
    const relativePath = reference.path === "storage" ? "" : reference.path.slice("storage/".length);
    const absolutePath = resolve(this.storageDirectory, relativePath);
    ensureWithinRoot(this.storageDirectory, absolutePath, "KNOWLEDGE_STORAGE_PATH_ESCAPE");
    try {
      const stats = await lstat(absolutePath);
      const canonicalPath = await realpath(absolutePath);
      if (!stats.isDirectory()) {
        throw new TerminalKnowledgeBuildError(
          "KNOWLEDGE_STORAGE_DIRECTORY_INVALID",
          `Referenced Knowledge storage directory is not a real directory: ${reference.path}`,
        );
      }
      ensureWithinRoot(realStorageRoot, canonicalPath, "KNOWLEDGE_STORAGE_SYMLINK_ESCAPE");
    } catch (error) {
      if (error instanceof TerminalKnowledgeBuildError) throw error;
      throw new TerminalKnowledgeBuildError(
        "KNOWLEDGE_STORAGE_DIRECTORY_UNAVAILABLE",
        `Referenced Knowledge storage directory is missing or unreadable: ${reference.path}`,
        { cause: error },
      );
    }
  }

  private async discoverAsset(
    declaration: KnowledgeStorageAssetDeclaration,
    realStorageRoot: string,
  ): Promise<DiscoveredAsset> {
    const storageRelativePath = declaration.path.slice("storage/".length);
    const category = storageRelativePath.split("/")[0]!;
    const categoryRoot = resolve(this.storageDirectory, category);
    const absolutePath = resolve(this.storageDirectory, storageRelativePath);
    ensureWithinRoot(categoryRoot, absolutePath, "KNOWLEDGE_STORAGE_PATH_ESCAPE");
    try {
      const canonicalCategoryRoot = await realpath(categoryRoot);
      ensureWithinRoot(realStorageRoot, canonicalCategoryRoot, "KNOWLEDGE_STORAGE_SYMLINK_ESCAPE");
      const logicalStats = await lstat(absolutePath, { bigint: true });
      const canonicalPath = await realpath(absolutePath);
      ensureWithinRoot(realStorageRoot, canonicalPath, "KNOWLEDGE_STORAGE_SYMLINK_ESCAPE");
      ensureWithinRoot(canonicalCategoryRoot, canonicalPath, "KNOWLEDGE_STORAGE_SYMLINK_ESCAPE");
      const targetStats = await lstat(canonicalPath, { bigint: true });
      if (!targetStats.isFile()) {
        throw new TerminalKnowledgeBuildError(
          "KNOWLEDGE_STORAGE_ASSET_NON_REGULAR",
          `Referenced Knowledge storage asset is not a regular file: ${declaration.path}`,
        );
      }
      return {
        declaration,
        absolutePath,
        canonicalPath,
        identity: identity(targetStats),
        symbolicLink: logicalStats.isSymbolicLink(),
      };
    } catch (error) {
      if (error instanceof TerminalKnowledgeBuildError) throw error;
      throw new TerminalKnowledgeBuildError(
        "KNOWLEDGE_STORAGE_ASSET_UNAVAILABLE",
        `Referenced Knowledge storage asset is missing or unreadable: ${declaration.path}`,
        { cause: error },
      );
    }
  }

  private async hashStableAsset(
    asset: DiscoveredAsset,
    signal?: AbortSignal,
  ): Promise<{ readonly byteSize: number; readonly sha256: string }> {
    throwIfAborted(signal);
    const handle = await open(asset.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameIdentity(asset.identity, identity(before))) {
        throw new RetryableKnowledgeBuildError(
          "KNOWLEDGE_STORAGE_CHANGED_DURING_READ",
          `Knowledge storage asset identity changed before it could be read: ${asset.declaration.path}`,
        );
      }
      const byteSize = safeSize(before.size, "KNOWLEDGE_STORAGE_ASSET_SIZE_INVALID");
      const digest = createHash("sha256");
      let readBytes = 0;
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        throwIfAborted(signal);
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        readBytes = checkedTotal(
          readBytes,
          bytes.byteLength,
          this.limits.maximumAssetFileBytes,
          "KNOWLEDGE_STORAGE_ASSET_SIZE_LIMIT_EXCEEDED",
          `Knowledge storage asset exceeds its byte limit: ${asset.declaration.path}`,
        );
        digest.update(bytes);
      }
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(identity(before), identity(after)) || readBytes !== byteSize) {
        throw new RetryableKnowledgeBuildError(
          "KNOWLEDGE_STORAGE_CHANGED_DURING_READ",
          `Knowledge storage asset changed while it was being read: ${asset.declaration.path}`,
        );
      }
      return { byteSize, sha256: digest.digest("hex") };
    } finally {
      await handle.close();
    }
  }
}

async function validateRootDirectory(root: string, code: string, detail: string): Promise<string> {
  const rootStats = await lstat(root, { bigint: true });
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new TerminalKnowledgeBuildError(code, detail);
  }
  return realpath(root);
}

function identity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sameMarkdownDiscovery(
  left: readonly DiscoveredMarkdown[],
  right: readonly DiscoveredMarkdown[],
): boolean {
  return left.length === right.length && left.every((file, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && file.sourcePath === candidate.sourcePath
      && sameIdentity(file.identity, candidate.identity);
  });
}

function sameAssetDiscovery(left: readonly DiscoveredAsset[], right: readonly DiscoveredAsset[]): boolean {
  return left.length === right.length && left.every((file, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && file.declaration.path === candidate.declaration.path
      && file.absolutePath === candidate.absolutePath
      && file.canonicalPath === candidate.canonicalPath
      && file.symbolicLink === candidate.symbolicLink
      && sameIdentity(file.identity, candidate.identity);
  });
}

function ensureWithinRoot(root: string, target: string, code: string): void {
  const candidate = relative(root, target);
  if (candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate))) return;
  throw new TerminalKnowledgeBuildError(code, "Knowledge source entry resolves outside its configured root");
}

function safeSize(value: bigint, code: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TerminalKnowledgeBuildError(code, "Knowledge source file has an invalid byte size");
  }
  return size;
}

function checkedTotal(
  current: number,
  increment: number,
  maximum: number,
  code: string,
  detail: string,
): number {
  const total = current + increment;
  if (!Number.isSafeInteger(total) || total > maximum) throw new TerminalKnowledgeBuildError(code, detail);
  return total;
}

function decodeMarkdown(content: string | Uint8Array, sourcePath: string): string {
  if (typeof content === "string") return content;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new TerminalKnowledgeBuildError(
      "KNOWLEDGE_VAULT_INVALID_ENCODING",
      `Knowledge vault Markdown is not valid UTF-8: ${sourcePath}`,
      { cause: error },
    );
  }
}

function changedDuringRead(detail: string): RetryableKnowledgeBuildError {
  return new RetryableKnowledgeBuildError("KNOWLEDGE_VAULT_CHANGED_DURING_READ", detail);
}

function toPosixPath(value: string): string {
  return value.split("\\").join("/").normalize("NFC");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("KNOWLEDGE_VAULT_READ_ABORTED");
}
