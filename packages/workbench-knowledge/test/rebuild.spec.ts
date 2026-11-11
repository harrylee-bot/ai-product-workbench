import { describe, expect, it } from "vitest";
import {
  buildKnowledgeRebuildPlan,
  buildKnowledgeRelease,
  type TokenizerPort,
  type VaultSourceInput,
} from "../src/index.js";

describe("full knowledge rebuild plan", () => {
  it("plans a complete same-key snapshot and records route transitions", () => {
    const sources: VaultSourceInput[] = [
      source("00-规则/old.md", "已生效", "# Old\n\nOld rule"),
      source("07-来源/evidence.md", "仅查来源", "# Evidence\n\nEvidence"),
      source("00-规则/new.md", "已生效", "# New\n\nNew rule"),
    ];
    const bundle = buildKnowledgeRelease({
      releaseKey: "workbench-1.0.0",
      releaseVersion: 2,
      sources,
      assets: [],
      tokenizer: characterTokenizer(),
      profile: {
        tokenizer: { id: "test", version: "1", maximumTokens: 200 },
        retrieval: { id: "retrieval", specSha256: "a".repeat(64) },
      },
    });
    const plan = buildKnowledgeRebuildPlan({
      current: {
        releaseKey: "workbench-1.0.0",
        releaseVersion: 1,
        documents: [
          { sourcePath: "00-规则/old.md", route: "production" },
          { sourcePath: "07-来源/evidence.md", route: "source_lookup" },
        ],
      },
      candidate: bundle,
    });

    expect(plan.mode).toBe("full-content-rebuild");
    expect(plan.releaseKey).toBe("workbench-1.0.0");
    expect(plan.candidateReleaseVersion).toBe(2);
    expect(plan.preservedPaths).toEqual(["00-规则/old.md", "07-来源/evidence.md"]);
    expect(plan.addedPaths).toEqual(["00-规则/new.md"]);
    expect(plan.removedPaths).toEqual([]);
    expect(plan.routeCounts).toEqual({ production: 2, source_lookup: 1, excluded: 0, quarantine: 0 });
    expect(plan.invariants).toEqual({
      sameLogicalKnowledgeBase: true,
      historyPreserved: true,
      sourceLookupExcludedFromProduction: true,
      incrementalParentRelease: null,
    });
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("rejects a second key or a skipped version", () => {
    const bundle = buildKnowledgeRelease({
      releaseKey: "other-key",
      releaseVersion: 3,
      sources: [source("00-规则/a.md", "已生效", "# A\n\nBody")],
      assets: [],
      tokenizer: characterTokenizer(),
      profile: {
        tokenizer: { id: "test", version: "1", maximumTokens: 200 },
        retrieval: { id: "retrieval", specSha256: "a".repeat(64) },
      },
    });
    expect(() => buildKnowledgeRebuildPlan({
      current: { releaseKey: "workbench-1.0.0", releaseVersion: 1, documents: [] },
      candidate: bundle,
    })).toThrow(/reuse the current release key/);
  });

  it("does not depend on source input ordering", () => {
    const sources = [
      source("00-规则/a.md", "已生效", "# A\n\nBody A"),
      source("00-规则/b.md", "已生效", "# B\n\nBody B"),
    ];
    const build = (ordered: readonly VaultSourceInput[]) => buildKnowledgeRelease({
      releaseKey: "workbench-1.0.0",
      releaseVersion: 2,
      sources: ordered,
      assets: [],
      tokenizer: characterTokenizer(),
      profile: {
        tokenizer: { id: "test", version: "1", maximumTokens: 200 },
        retrieval: { id: "retrieval", specSha256: "a".repeat(64) },
      },
    });
    const current = { releaseKey: "workbench-1.0.0", releaseVersion: 1, documents: [] } as const;
    const left = buildKnowledgeRebuildPlan({ current, candidate: build(sources) });
    const right = buildKnowledgeRebuildPlan({ current, candidate: build([...sources].reverse()) });
    expect(left.planSha256).toBe(right.planSha256);
    expect(left.routeTransitions).toEqual(right.routeTransitions);
  });
});

function source(path: string, status: string, body: string): VaultSourceInput {
  return {
    path,
    content: [
      "---",
      `title: ${path}`,
      `status: ${status}`,
      "tags: [test]",
      "aliases: []",
      "---",
      "",
      body,
      "",
    ].join("\n"),
  };
}

function characterTokenizer(): TokenizerPort {
  return {
    count: (text) => Array.from(text).length,
    split: ({ text, maximumTokens }) => {
      const characters = Array.from(text);
      const slices = [];
      for (let index = 0; index < characters.length; index += maximumTokens) {
        const value = characters.slice(index, index + maximumTokens).join("");
        slices.push({ text: value, tokenCount: Array.from(value).length });
      }
      return slices;
    },
  };
}
