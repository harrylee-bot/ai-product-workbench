import { BadRequestException } from "@nestjs/common";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export function resolveStoragePath(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return resolvedPath;
  }

  throw new BadRequestException("文件存储路径非法");
}

export function assertStoragePath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = resolveStoragePath(resolvedRoot, path.resolve(candidate));
  if (resolvedPath === resolvedRoot) {
    throw new BadRequestException("文件存储路径不能指向存储根目录");
  }
  return resolvedPath;
}

export async function resolveExistingStorageFile(root: string, candidate: string) {
  const lexicalPath = assertStoragePath(root, candidate);
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = await realpath(path.resolve(root));
    canonicalPath = assertStoragePath(canonicalRoot, await realpath(lexicalPath));
  } catch {
    throw new BadRequestException("文件存储路径不存在或已越过存储根目录");
  }
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) {
    throw new BadRequestException("文件存储路径不是普通文件");
  }
  return { path: canonicalPath, size: fileStat.size };
}
