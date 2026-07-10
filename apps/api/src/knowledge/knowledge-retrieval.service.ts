import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { KnowledgePriority, KnowledgeStatus, KnowledgeType } from "@prisma/client";
import { toInputJson } from "../ai/ai-vibe.helpers";
import { MODE_BOOST_TYPES } from "../ai/requirement-mode.helper";
import { PrismaService } from "../prisma/prisma.service";
import { KnowledgeEmbeddingService } from "./knowledge-embedding.service";
import { jsonArray } from "./knowledge-item.service";
import type {
  KnowledgeReference,
  KnowledgeRetrievalResult,
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
} from "./knowledge.types";

type ScorableKnowledgeItem = {
  id: string;
  title: string;
  content: string;
  summary?: string | null;
  type: KnowledgeType;
  priority: KnowledgePriority;
  tags?: unknown;
  category?: { name?: string | null } | null;
  sourceFileId?: string | null;
  relatedPath?: string;
};

type VaultKnowledgeItem = ScorableKnowledgeItem & {
  relatedPath: string;
};

let vaultCache:
  | {
      root: string;
      loadedAt: number;
      items: VaultKnowledgeItem[];
    }
  | undefined;

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings?: KnowledgeEmbeddingService,
  ) {}

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchOutput> {
    const query = input.query.trim();
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);
    const preferredTypes = input.preferredTypes?.length
      ? [...new Set(input.preferredTypes)]
      : undefined;
    const strictPreferredTypes = Boolean(input.strictPreferredTypes && preferredTypes?.length);
    const modeBoostTypes = input.requirementMode ? MODE_BOOST_TYPES[input.requirementMode] : undefined;
    const vaultPolicy = input.vaultPolicy ?? "on_miss";
    const retrievalAudience = resolveRetrievalAudience(query);

    try {
      const databaseItems = await this.prisma.knowledgeItem.findMany({
        where: {
          status: KnowledgeStatus.active,
          ...(strictPreferredTypes ? { type: { in: preferredTypes } } : {}),
          OR: [
            { scope: "global" },
            ...(input.conversationId
              ? [{ scope: "conversation" as const, sourceConversationId: input.conversationId }]
              : []),
          ],
        },
        include: { category: true },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
      });
      const items = databaseItems.filter((item) => shouldUseKnowledgeItem(item, retrievalAudience));

      const semanticScores = this.embeddings
        ? await this.embeddings.scoreItems(query, items)
        : new Map<string, number>();
      const matched = items
        .map((item) => scoreItem(item, query, preferredTypes, semanticScores.get(item.id), modeBoostTypes))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score
          || queryTitleOverlap(b, query) - queryTitleOverlap(a, query)
          || priorityWeight(b.priority) - priorityWeight(a.priority));
      const vaultMatches = shouldSearchVault(vaultPolicy, matched, strictPreferredTypes)
        ? await this.searchVaultFallback(query, preferredTypes, modeBoostTypes, retrievalAudience)
        : [];
      const combined = mergeRetrievalResults(matched, vaultMatches).sort(
        (a, b) => b.score - a.score
          || queryTitleOverlap(b, query) - queryTitleOverlap(a, query)
          || priorityWeight(b.priority) - priorityWeight(a.priority),
      );
      const selected = selectKnowledgeResults(combined, limit, query, {
        preferredTypes,
        runtimeName: input.runtimeName,
      });
      let retrievalError: string | undefined;

      try {
        await this.prisma.knowledgeRetrievalLog.create({
          data: {
            conversationId: input.conversationId,
            runId: input.runId,
            runtimeName: input.runtimeName,
            query,
            taskType: input.taskType ? String(input.taskType) : undefined,
            matchedKnowledgeIds: toInputJson(combined.map((item) => item.itemId)),
            selectedKnowledgeIds: toInputJson(selected.map((item) => item.itemId)),
          },
        });
      } catch (error) {
        retrievalError = `知识检索日志写入失败：${errorMessage(error)}`;
      }

      return {
        results: selected,
        references: selected.map((item, index) => toReference(item, input.runtimeName, index)),
        topScore: selected[0]?.score,
        matchedCount: combined.length,
        selectedCount: selected.length,
        retrievalError,
        retrievalSource: resolveRetrievalSource(selected),
      };
    } catch (error) {
      const vaultMatches = vaultPolicy === "never"
        ? []
        : await this.searchVaultFallback(query, preferredTypes, modeBoostTypes, retrievalAudience).catch(() => []);
      const selected = selectKnowledgeResults(vaultMatches, limit, query, {
        preferredTypes,
        runtimeName: input.runtimeName,
      });
      if (selected.length) {
        return {
          results: selected,
          references: selected.map((item, index) => toReference(item, input.runtimeName, index)),
          topScore: selected[0]?.score,
          matchedCount: vaultMatches.length,
          selectedCount: selected.length,
          retrievalError: `数据库知识检索失败，已使用 Markdown 知识库兜底：${errorMessage(error)}`,
          retrievalSource: "vault_fallback",
        };
      }
      return {
        results: [],
        references: [],
        matchedCount: 0,
        selectedCount: 0,
        retrievalError: `知识检索失败：${errorMessage(error)}`,
      };
    }
  }

  private async searchVaultFallback(
    query: string,
    preferredTypes?: KnowledgeType[],
    modeBoostTypes?: KnowledgeType[],
    retrievalAudience: KnowledgeRetrievalAudience = "main",
  ): Promise<KnowledgeRetrievalResult[]> {
    const items = await loadVaultKnowledgeItems();
    return items
      .filter((item) => shouldUseKnowledgeItem(item, retrievalAudience))
      .map((item) => scoreItem(item, query, preferredTypes, undefined, modeBoostTypes))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score
        || queryTitleOverlap(b, query) - queryTitleOverlap(a, query)
        || priorityWeight(b.priority) - priorityWeight(a.priority));
  }
}

type KnowledgeRetrievalAudience = "main" | "source" | "inbox";

function resolveRetrievalAudience(query: string): KnowledgeRetrievalAudience {
  const normalized = normalizeText(query);
  if (/(收件箱|待整理资料|未整理资料|待处理资料)/.test(normalized)) return "inbox";
  if (/(来源资产|原始资料|原始文件|导入记录|资产清单|资料出处|内容出处|旧版资料|历史资料|核验来源|追溯来源|查找来源|查看来源)/.test(normalized)) {
    return "source";
  }
  return "main";
}

function shouldUseKnowledgeItem(item: ScorableKnowledgeItem, audience: KnowledgeRetrievalAudience) {
  const relatedPath = normalizeKnowledgePath(item.relatedPath ?? item.sourceFileId);
  if (!relatedPath) return audience !== "inbox";
  if (relatedPath.startsWith("_templates/") || relatedPath.includes("/_templates/")) return false;
  if (relatedPath.startsWith("99-收件箱/")) return audience === "inbox";
  if (audience === "inbox") return false;
  if (relatedPath.startsWith("07-来源资产索引/")) return audience === "source";
  return true;
}

function normalizeKnowledgePath(value: string | null | undefined) {
  return value?.replaceAll("\\", "/").trim() ?? "";
}

function shouldSearchVault(
  vaultPolicy: NonNullable<KnowledgeSearchInput["vaultPolicy"]>,
  matched: KnowledgeRetrievalResult[],
  strictPreferredTypes: boolean,
) {
  if (strictPreferredTypes || vaultPolicy === "never") return false;
  if (vaultPolicy === "always") return true;
  return matched.length === 0;
}

function scoreItem(
  item: ScorableKnowledgeItem,
  query: string,
  preferredTypes?: KnowledgeType[],
  semanticScore?: number,
  modeBoostTypes?: KnowledgeType[],
): KnowledgeRetrievalResult {
  const tokens = tokenize(query);
  const tags = jsonArray(item.tags);
  const fields = {
    title: normalizeText(item.title),
    summary: normalizeText(item.summary ?? ""),
    content: normalizeText(item.content),
    tags: normalizeText(tags.join(" ")),
    category: normalizeText(item.category?.name ?? ""),
    type: item.type,
  };

  const reasons: string[] = [];
  let keywordScore = 0;
  if (!tokens.length) {
    keywordScore += 0.1;
    reasons.push("无关键词时按最近活跃知识兜底");
  }

  for (const token of tokens) {
    if (fields.title.includes(token)) {
      keywordScore += fields.title === token ? 0.6 : 0.34;
      reasons.push(`标题匹配 ${token}`);
    }
    if (fields.tags.includes(token)) {
      keywordScore += 0.28;
      reasons.push(`标签匹配 ${token}`);
    }
    if (fields.summary.includes(token)) {
      keywordScore += 0.2;
      reasons.push(`摘要匹配 ${token}`);
    }
    if (fields.content.includes(token)) {
      keywordScore += 0.14;
      reasons.push(`正文匹配 ${token}`);
    }
    if (fields.category.includes(token)) {
      keywordScore += 0.12;
      reasons.push(`分类匹配 ${token}`);
    }
    if (fields.type.includes(token)) {
      keywordScore += 0.08;
      reasons.push(`类型匹配 ${token}`);
    }
  }

  if (preferredTypes?.includes(item.type)) {
    keywordScore += 0.16;
    reasons.push("符合调用方偏好类型");
  }
  if (modeBoostTypes?.includes(item.type)) {
    // requirementMode 驱动：模式偏重类型额外加权，仅影响排序不收缩召回。
    keywordScore += 0.12;
    reasons.push("符合需求模式偏重");
  }
  keywordScore += priorityWeight(item.priority);
  if (item.priority === "high") reasons.push("高优先级知识");
  if (semanticScore !== undefined && semanticScore >= 0.18) {
    reasons.push(`语义相似度 ${semanticScore.toFixed(2)}`);
  }

  const normalizedKeywordScore = Math.min(keywordScore, 1);
  const score = semanticScore === undefined
    ? normalizedKeywordScore
    : Math.min(1, normalizedKeywordScore * 0.62 + semanticScore * 0.48);

  return {
    itemId: item.id,
    title: item.title,
    content: item.content,
    summary: item.summary ?? undefined,
    type: item.type,
    priority: item.priority,
    score: Number(score.toFixed(3)),
    keywordScore: Number(normalizedKeywordScore.toFixed(3)),
    semanticScore,
    reason: [...new Set(reasons)].slice(0, 5).join("；") || "按知识优先级命中",
    relatedPath: item.relatedPath ?? item.sourceFileId ?? undefined,
    visualAssets: extractVisualAssets(item),
  };
}

function toReference(
  result: KnowledgeRetrievalResult,
  usedByRuntime: string | undefined,
  index: number,
): KnowledgeReference {
  return {
    id: `knowledge_ref_${result.itemId}_${index + 1}`,
    knowledgeId: result.itemId,
    title: result.title,
    snippet: result.summary || result.content.slice(0, 160),
    content: result.content,
    type: result.type,
    score: result.score,
    semanticScore: result.semanticScore,
    reason: result.reason,
    usedByRuntime,
    sourceType: "knowledge_base",
    sourceId: result.itemId,
    relatedPath: result.relatedPath,
    visualAssets: result.visualAssets,
  };
}

function extractVisualAssets(item: ScorableKnowledgeItem) {
  if (item.type !== KnowledgeType.prototype_snapshot) return undefined;
  const paths = [...item.content.matchAll(/(?:截图路径|图片路径|previewImagePath)[:：]\s*([^\n]+)/g)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  if (!paths.length) return undefined;
  return paths.slice(0, 5).map((assetPath) => ({
    kind: "prototype_snapshot" as const,
    title: item.title,
    path: assetPath,
    note: item.summary ?? "原型页面截图",
  }));
}

function mergeRetrievalResults(
  databaseResults: KnowledgeRetrievalResult[],
  vaultResults: KnowledgeRetrievalResult[],
) {
  if (!vaultResults.length) return databaseResults;
  const databasePaths = new Set(
    databaseResults.map((item) => normalizeKnowledgePath(item.relatedPath)).filter(Boolean),
  );
  const seen = new Set<string>();
  const merged: KnowledgeRetrievalResult[] = [];
  for (const item of [...databaseResults, ...vaultResults]) {
    const relatedPath = normalizeKnowledgePath(item.relatedPath);
    if (item.itemId.startsWith("vault:") && relatedPath && databasePaths.has(relatedPath)) continue;
    const key = item.itemId.startsWith("vault:") ? `vault:${relatedPath || item.title}` : item.itemId;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function resolveRetrievalSource(selected: KnowledgeRetrievalResult[]): KnowledgeSearchOutput["retrievalSource"] {
  const hasDatabase = selected.some((item) => !item.itemId.startsWith("vault:"));
  const hasVault = selected.some((item) => item.itemId.startsWith("vault:"));
  if (hasDatabase && hasVault) return "database_and_vault";
  if (hasVault) return "vault_fallback";
  return "database";
}

function selectKnowledgeResults(
  ranked: KnowledgeRetrievalResult[],
  limit: number,
  query: string,
  options: {
    preferredTypes?: KnowledgeType[];
    runtimeName?: string;
  } = {},
) {
  const eligible = ranked.filter((item) => {
    if (item.type !== KnowledgeType.prototype_asset_ref && item.type !== KnowledgeType.business_concept) return true;
    return queryTitleOverlap(item, query) > 0;
  });
  const requiredGroups = requiredKnowledgeGroups(query, options);
  if (!eligible.length || !requiredGroups.length) return eligible.slice(0, limit);

  const front: KnowledgeRetrievalResult[] = [];
  const frontIds = new Set<string>();
  for (const group of requiredGroups) {
    const candidate = findRequiredGroupRepresentative(eligible, frontIds, group, query);
    if (!candidate) continue;
    front.push(candidate);
    frontIds.add(candidate.itemId);
  }

  const rest = eligible.filter((item) => !frontIds.has(item.itemId));
  return [...front, ...rest].slice(0, limit);
}

function findRequiredGroupRepresentative(
  ranked: KnowledgeRetrievalResult[],
  usedIds: Set<string>,
  group: KnowledgeGroupRequirement,
  query: string,
) {
  const candidates = ranked.filter((item) => !usedIds.has(item.itemId) && matchesKnowledgeGroup(item, group));
  if (!candidates.length) return undefined;
  if (group.preferQueryOverlap) {
    const sorted = [...candidates].sort((a, b) => queryTitleOverlap(b, query) - queryTitleOverlap(a, query) || b.score - a.score);
    const best = sorted[0];
    if (group.requireQueryOverlap && queryTitleOverlap(best, query) <= 0) return undefined;
    return best;
  }
  if (!group.preferredPattern) return candidates[0];
  return candidates.find((item) => group.preferredPattern?.test(knowledgeGroupText(item))) ?? candidates[0];
}

type KnowledgeGroupRequirement = {
  type?: KnowledgeType;
  pattern: RegExp;
  preferredPattern?: RegExp;
  preferQueryOverlap?: boolean;
  requireQueryOverlap?: boolean;
};

function requiredKnowledgeGroups(
  query: string,
  options: {
    preferredTypes?: KnowledgeType[];
    runtimeName?: string;
  } = {},
): KnowledgeGroupRequirement[] {
  const normalized = normalizeText(query);
  const groups: KnowledgeGroupRequirement[] = [];
  const isRuntimeGeneration = options.runtimeName === "runtime_generation";
  const prefersPrdRules = options.preferredTypes?.includes(KnowledgeType.prd_writing_rule);
  const prefersPrototypeRules = options.preferredTypes?.includes(KnowledgeType.prototype_rule);

  if (
    /(需求文档|需求说明书|prd|产品文档|文档)/i.test(normalized) ||
    (isRuntimeGeneration && prefersPrdRules)
  ) {
    groups.push({
      type: KnowledgeType.prd_writing_rule,
      pattern: /PRD标准结构|需求说明书|需求文档|产品文档规范/,
      preferredPattern: /PRD标准结构/,
    });
  }
  if (
    /(原型|prototype|页面|界面|交互)/i.test(normalized) ||
    (isRuntimeGeneration && prefersPrototypeRules)
  ) {
    groups.push({
      type: KnowledgeType.prototype_rule,
      pattern: /原型生成总规则|前后台页面框架|后台通用框架|前台通用框架|prototype/i,
      preferredPattern: /原型生成总规则/,
    });
    groups.push({
      type: KnowledgeType.prototype_asset_ref,
      pattern: /./,
      preferQueryOverlap: true,
      requireQueryOverlap: true,
    });
  }
  if (/(需求文档|需求说明书|prd|原型|prototype|页面|界面|交互|方案)/i.test(normalized)) {
    groups.push({
      type: KnowledgeType.business_concept,
      pattern: /./,
      preferQueryOverlap: true,
      requireQueryOverlap: true,
    });
  }

  return groups;
}

function matchesKnowledgeGroup(item: KnowledgeRetrievalResult, group: KnowledgeGroupRequirement) {
  if (group.type && item.type !== group.type) return false;
  return group.pattern.test(knowledgeGroupText(item));
}

function knowledgeGroupText(item: KnowledgeRetrievalResult) {
  return `${item.title}\n${item.relatedPath ?? ""}\n${item.summary ?? ""}\n${item.content.slice(0, 800)}`;
}

async function loadVaultKnowledgeItems() {
  const root = await resolveKnowledgeVaultRoot();
  if (!root) return [];
  const now = Date.now();
  if (vaultCache && vaultCache.root === root && now - vaultCache.loadedAt < 60_000) {
    return vaultCache.items;
  }

  const files = await listMarkdownFiles(root);
  const items: VaultKnowledgeItem[] = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const content = await readFile(absolutePath, "utf8").catch(() => "");
    if (!content.trim()) continue;
    items.push(toVaultKnowledgeItem(relativePath, content));
  }

  vaultCache = { root, loadedAt: now, items };
  return items;
}

async function resolveKnowledgeVaultRoot() {
  for (const candidate of resolveKnowledgeVaultRootCandidates()) {
    if (!existsSync(candidate)) continue;
    const files = await listMarkdownFiles(candidate);
    if (files.length) return candidate;
  }
  return undefined;
}

function resolveKnowledgeVaultRootCandidates() {
  const explicit = process.env.KNOWLEDGE_VAULT_ROOT?.trim();
  const cwd = process.cwd();
  const candidates = [
    ...(explicit ? [path.resolve(explicit)] : []),
    path.resolve(cwd, "knowledge-vault"),
    path.resolve(cwd, "..", "..", "knowledge-vault"),
    path.resolve(cwd, "storage", "knowledge-vault"),
  ];
  return [...new Set(candidates)];
}

async function listMarkdownFiles(root: string) {
  const results: string[] = [];
  await walkVault(root, root, results);
  return results.sort((a, b) => vaultPathRank(a) - vaultPathRank(b) || a.localeCompare(b, "zh-Hans-CN"));
}

async function walkVault(root: string, dir: string, results: string[]) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await walkVault(root, absolutePath, results);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    results.push(path.relative(root, absolutePath).split(path.sep).join("/"));
  }
}

function toVaultKnowledgeItem(relativePath: string, rawContent: string): VaultKnowledgeItem {
  const title = extractMarkdownTitle(relativePath, rawContent);
  const content = trimVaultContent(rawContent, relativePath);
  return {
    id: `vault:${relativePath}`,
    title,
    content,
    summary: summarizeMarkdown(content),
    type: inferVaultKnowledgeType(relativePath, rawContent),
    priority: inferVaultPriority(relativePath),
    tags: extractMarkdownTags(rawContent),
    category: { name: relativePath.split("/")[0] ?? "knowledge-vault" },
    sourceFileId: relativePath,
    relatedPath: relativePath,
  };
}

function extractMarkdownTitle(relativePath: string, content: string) {
  const frontmatterTitle = content.match(/(?:^|\n)title:\s*["']?([^"'\n]+)["']?/)?.[1]?.trim();
  if (frontmatterTitle) return frontmatterTitle;
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.basename(relativePath, ".md");
}

function trimVaultContent(content: string, relativePath: string) {
  const compact = content.replace(/\n{3,}/g, "\n\n").trim();
  const limit = isSourceAssetPath(relativePath) ? 6000 : 12000;
  return compact.length > limit ? `${compact.slice(0, limit)}\n\n（内容已截断，原始路径：${relativePath}）` : compact;
}

function summarizeMarkdown(content: string) {
  return content
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function extractMarkdownTags(content: string) {
  const tags: string[] = [];
  const tagBlock = content.match(/tags:\s*([\s\S]*?)(?:\n[a-zA-Z\u4e00-\u9fa5_-]+:|\n---|\n#|$)/)?.[1] ?? "";
  for (const line of tagBlock.split("\n")) {
    const tag = line.replace(/^[-\s]+/, "").trim();
    if (tag) tags.push(tag);
  }
  return tags;
}

function inferVaultKnowledgeType(relativePath: string, content: string): KnowledgeType {
  if (isPrototypeAssetReference(relativePath, content)) return KnowledgeType.prototype_asset_ref;
  if (relativePath.startsWith("00-")) return KnowledgeType.strong_rule;
  if (relativePath.startsWith("01-")) return KnowledgeType.product_architecture;
  if (relativePath.startsWith("02-")) return KnowledgeType.business_concept;
  if (relativePath.startsWith("03-")) return KnowledgeType.design_pattern;
  if (relativePath.startsWith("04-")) return KnowledgeType.prd_writing_rule;
  if (relativePath.startsWith("05-")) return KnowledgeType.prototype_rule;
  if (relativePath.startsWith("06-")) return KnowledgeType.reference_case;
  if (/案例|历史/.test(relativePath)) return KnowledgeType.reference_case;
  return KnowledgeType.default_rule;
}

function isPrototypeAssetReference(relativePath: string, content: string) {
  if (/原型生成总规则|字段接口状态表达|前后台页面框架/.test(relativePath)) return false;
  const titleAndPath = relativePath;
  const frontmatterAndIntro = content.slice(0, 1200);
  return /高保真(?:HTML)?原型框架|原型转HTML|原型资产索引|RP资产到设计框架映射/i.test(titleAndPath)
    || /tags:\s*[\s\S]{0,400}(Axure|RP资产|prototype_asset_ref)/i.test(frontmatterAndIntro)
    || /source:\s*storage\/imports\/.*(?:axure|\.html|\.rp)/i.test(frontmatterAndIntro)
    || /prototype_asset_ref/i.test(frontmatterAndIntro);
}

function inferVaultPriority(relativePath: string): KnowledgePriority {
  if (/^(00|01|02|03|04|05)-/.test(relativePath)) return KnowledgePriority.high;
  if (relativePath.startsWith("06-")) return KnowledgePriority.medium;
  return KnowledgePriority.low;
}

function vaultPathRank(relativePath: string) {
  if (/^(00|01|02|03|04|05)-/.test(relativePath)) return 0;
  if (relativePath.startsWith("06-")) return 1;
  if (relativePath.startsWith("07-")) return 2;
  if (relativePath.startsWith("99-")) return 3;
  return 4;
}

function isSourceAssetPath(relativePath: string) {
  return relativePath.startsWith("07-") || relativePath.startsWith("99-");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function tokenize(query: string) {
  const normalized = normalizeText(query);
  const segments = normalized.match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/gi) ?? [];
  const tokens: string[] = [];

  for (const segment of segments) {
    if (/^[a-z0-9]+$/i.test(segment)) {
      tokens.push(segment);
      continue;
    }

    tokens.push(...extractChineseTerms(segment));
  }

  return [...new Set(tokens.map((item) => item.trim()).filter((item) => item.length >= 2))]
    .slice(0, 28);
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractChineseTerms(segment: string) {
  const terms: string[] = [];
  if (segment.length <= 10) terms.push(segment);

  const domainTerms = [
    "产品",
    "架构",
    "能力",
    "能力地图",
    "需求",
    "prd",
    "原型",
    "prototypespec",
    "openpencil",
    "规则",
    "约束",
    "知识库",
    "业务域",
    "产品逻辑",
    "进化",
    "路线图",
    "历史业务",
    "增量",
    "创新",
    "验收",
    "风险",
    "业务",
    "对象",
    "配置",
    "操作",
    "结果",
    "报表",
    "数据",
    "案例",
    "后台",
    "前台",
    "前后台",
    "字段",
    "接口",
    "状态",
    "审核",
    "发布",
    "回滚",
    "导出",
    "日志",
    "权限",
    "管理员",
    "登录",
    "移动端",
    "页面",
    "流程",
  ];
  for (const term of domainTerms) {
    if (segment.includes(term)) terms.push(term);
  }

  for (let index = 0; index < segment.length - 1 && terms.length < 24; index += 1) {
    terms.push(segment.slice(index, index + 2));
  }
  for (let index = 0; index < segment.length - 2 && terms.length < 28; index += 1) {
    terms.push(segment.slice(index, index + 3));
  }

  return terms;
}

function priorityWeight(priority: KnowledgeRetrievalResult["priority"]) {
  if (priority === "high") return 0.15;
  if (priority === "medium") return 0.08;
  return 0.03;
}

function queryTitleOverlap(item: KnowledgeRetrievalResult, query: string) {
  const generic = new Set([
    "我想", "想做", "做一", "一个", "请帮", "帮我", "根据", "内容", "创建", "设计",
    "需求", "文档", "需求文档", "需求说明书", "prd", "原型", "页面", "界面", "生成", "功能", "知识库",
    "产品", "业务", "规则", "状态", "流程", "前台", "后台", "配置", "管理", "系统", "平台",
  ]);
  const tokens = tokenize(query).filter((token) => !generic.has(token));
  const title = normalizeText(item.title);
  const summary = normalizeText(item.summary ?? "");
  return tokens.reduce((score, token) => score + (title.includes(token) ? 3 : 0) + (summary.includes(token) ? 1 : 0), 0);
}
