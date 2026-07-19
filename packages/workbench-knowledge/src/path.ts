import { posix } from "node:path";

import { sha256 } from "./checksum.js";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;

export interface NormalizedVaultPath {
  readonly valid: boolean;
  readonly path: string;
  readonly locator: string;
  readonly reason?: string;
}

export function normalizeVaultPath(input: string, vaultRoot = "knowledge-vault"): NormalizedVaultPath {
  const raw = input.normalize("NFC").replaceAll("\\", "/");
  const absolute = raw.startsWith("/") || WINDOWS_ABSOLUTE.test(raw) || URI_SCHEME.test(raw);
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  const traverses = segments.some((segment) => segment === "..");
  const normalized = segments.join("/");
  const valid = !absolute
    && !traverses
    && !raw.includes("\0")
    && normalized.length > 0
    && normalized.toLocaleLowerCase("en-US").endsWith(".md");

  if (!valid) {
    const digest = sha256(raw);
    return {
      valid: false,
      path: normalized || "invalid.md",
      locator: `vault://${encodeSegment(vaultRoot)}/__quarantine__/${digest}`,
      reason: absolute
        ? "source path must be relative to the vault root"
        : traverses
          ? "source path cannot traverse outside the vault root"
          : "source path must be a non-empty Markdown path",
    };
  }

  return {
    valid: true,
    path: normalized,
    locator: vaultLocator(normalized, vaultRoot),
  };
}

export function vaultLocator(sourcePath: string, vaultRoot = "knowledge-vault"): string {
  return `vault://${encodeSegment(vaultRoot)}/${sourcePath.split("/").map(encodeSegment).join("/")}`;
}

export function resolveRelativeVaultPath(
  fromPath: string,
  target: string,
  vaultRoot = "knowledge-vault",
): NormalizedVaultPath {
  const decoded = safeDecodeUri(target).normalize("NFC").replaceAll("\\", "/");
  if (decoded.startsWith("/") || WINDOWS_ABSOLUTE.test(decoded) || URI_SCHEME.test(decoded)) {
    return normalizeVaultPath(decoded, vaultRoot);
  }

  const withExtension = posix.extname(decoded) === "" ? `${decoded}.md` : decoded;
  return normalizeVaultPath(posix.join(posix.dirname(fromPath), withExtension), vaultRoot);
}

export function isAbsoluteOrExternalTarget(target: string): boolean {
  const normalized = target.replaceAll("\\", "/");
  return normalized.startsWith("/") || WINDOWS_ABSOLUTE.test(normalized) || URI_SCHEME.test(normalized);
}

export function isExternalUrl(target: string): boolean {
  return URI_SCHEME.test(target) && !WINDOWS_ABSOLUTE.test(target.replaceAll("\\", "/"));
}

export function withoutMarkdownExtension(path: string): string {
  return path.toLocaleLowerCase("en-US").endsWith(".md") ? path.slice(0, -3) : path;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
