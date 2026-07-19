import type { ImportSource } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  figmaVersionFromInput,
  importSourceListRefetchInterval,
  importSourceRefetchInterval,
  importSourceDraftProjectTitle,
  isImportSourceUrlAllowed,
  isReadyImportSource,
  normalizeFigmaFileKey,
  normalizeGitHubRepository,
} from "./index";

const timestamp = "2026-07-18T00:00:00.000Z";

function source(overrides: Partial<ImportSource> = {}): ImportSource {
  return {
    id: "source-1",
    projectId: "project-1",
    createdById: "user-1",
    kind: "url_snapshot",
    status: "pending",
    label: "Example",
    descriptor: null,
    checksum: null,
    revision: 0,
    failure: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe("Import Source domain helpers", () => {
  it("normalizes GitHub and Figma inputs without fetching external content", () => {
    expect(normalizeGitHubRepository("https://github.com/acme/design-system.git")).toBe("acme/design-system");
    expect(normalizeFigmaFileKey("https://www.figma.com/design/file_key/My-file?node-id=1-2")).toBe("file_key");
    expect(figmaVersionFromInput("https://www.figma.com/file/file_key/demo?version-id=42")).toBe("42");
    expect(figmaVersionFromInput("file_key")).toBeUndefined();
  });

  it("rejects obvious local and private network locators before they reach the API", () => {
    expect(isImportSourceUrlAllowed("https://example.com/docs")).toBe(true);
    expect(isImportSourceUrlAllowed("http://localhost:8080")).toBe(false);
    expect(isImportSourceUrlAllowed("http://127.0.0.1/admin")).toBe(false);
    expect(isImportSourceUrlAllowed("http://192.168.1.10")).toBe(false);
    expect(isImportSourceUrlAllowed("ftp://example.com/file")).toBe(false);
  });

  it("polls only pending sources", () => {
    expect(importSourceRefetchInterval(source())).toBe(1_500);
    expect(importSourceRefetchInterval(source({ status: "ready", checksum: "a".repeat(64) }))).toBe(false);
    expect(importSourceListRefetchInterval([source()])).toBe(1_500);
    expect(importSourceListRefetchInterval([source({ status: "failed", failure: { code: "x", message: "no" } })])).toBe(false);
  });

  it("recognizes ready sources and derives a bounded project title", () => {
    const ready = source({
      status: "ready",
      checksum: "a".repeat(64),
      descriptor: { kind: "url_snapshot", sourceUrl: "https://example.com", resolvedUrl: "https://example.com" },
    });
    expect(isReadyImportSource(ready)).toBe(true);
    expect(isReadyImportSource(source({ status: "deleted", deletedAt: timestamp }))).toBe(false);
    expect(importSourceDraftProjectTitle({ kind: "url_snapshot", sourceUrl: "https://example.com" })).toBe("example.com");
    expect(importSourceDraftProjectTitle({ kind: "github_snapshot", repository: "acme/repo", ref: "main" })).toBe("acme/repo");
  });
});
