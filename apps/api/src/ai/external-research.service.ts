import { Injectable, Logger } from "@nestjs/common";

export type ExternalResearchReference = {
  query: string;
  title: string;
  url: string;
  insight: string;
  source: "public_web_fetch";
  contentLength: number;
  fetchedAt: string;
};

export type ExternalResearchContext = {
  status: "completed" | "skipped_not_needed" | "failed_non_blocking" | "failed";
  fetchedAt: string;
  searchQueries: string[];
  refs: ExternalResearchReference[];
  failures: Array<{
    query?: string;
    url?: string;
    error: string;
  }>;
  privacyBoundary: string[];
  cacheHit?: boolean;
};

type ExternalResearchSource = {
  query: string;
  url: string;
  expectedTitle: string;
  insight: string;
};

@Injectable()
export class ExternalResearchService {
  private readonly logger = new Logger(ExternalResearchService.name);
  private readonly cache = new Map<string, { expiresAt: number; context: ExternalResearchContext }>();
  private readonly inFlight = new Map<string, Promise<ExternalResearchContext>>();

  async research(input: {
    message: string;
    knowledgeHitCount: number;
    signal?: AbortSignal;
  }): Promise<ExternalResearchContext> {
    const fetchedAt = new Date().toISOString();
    const searchQueries = buildWebSearchQueries(input.message);
    const privacyBoundary = [
      "只搜索通用领域词，不发送知识库路径、内部文件路径、附件原文、会话 ID、用户 ID、真实接口或密钥。",
      "外部资料只补充行业惯例、体验参考、幂等/限流等通用工程概念，不覆盖本地知识库规则。",
      "只向 DeerFlow 注入标题、URL、简短归纳和抓取状态，不注入网页全文。",
    ];

    if (input.knowledgeHitCount <= 0 || searchQueries.length === 0) {
      return { status: "skipped_not_needed", fetchedAt, searchQueries, refs: [], failures: [], privacyBoundary };
    }

    const cacheKey = cacheKeyForQueries(searchQueries);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneResearchContext(cached.context, true);
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      const context = await existing;
      return cloneResearchContext(context, true);
    }

    const request = this.fetchResearchContext(searchQueries, privacyBoundary, fetchedAt, input.signal)
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, request);
    const context = await request;
    if (context.refs.length > 0) {
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + readNumberEnv("EXTERNAL_RESEARCH_CACHE_TTL_MS", 6 * 60 * 60 * 1000),
        context: cloneResearchContext(context, false),
      });
    }
    return context;
  }

  private async fetchResearchContext(
    searchQueries: string[],
    privacyBoundary: string[],
    fetchedAt: string,
    signal?: AbortSignal,
  ): Promise<ExternalResearchContext> {
    const sources = buildExternalSources(searchQueries);
    const settled = await Promise.allSettled(sources.map((source) => this.fetchReference(source, fetchedAt, signal)));
    const refs = settled
      .filter((result): result is PromiseFulfilledResult<ExternalResearchReference> => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = settled
      .map((result, index) => result.status === "rejected"
        ? {
            query: sources[index]?.query ?? "",
            url: sources[index]?.url ?? "",
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }
        : null)
      .filter((item): item is { query: string; url: string; error: string } => Boolean(item));

    if (failures.length) {
      this.logger.warn(`外部补充资料部分抓取失败：${JSON.stringify(failures.slice(0, 3))}`);
    }

    return {
      status: refs.length >= 3 ? "completed" : refs.length > 0 ? "failed_non_blocking" : "failed",
      fetchedAt,
      searchQueries,
      refs,
      failures,
      privacyBoundary,
      cacheHit: false,
    };
  }

  private async fetchReference(
    source: ExternalResearchSource,
    fetchedAt: string,
    parentSignal?: AbortSignal,
  ): Promise<ExternalResearchReference> {
    const html = await fetchText(source.url, parentSignal);
    if (html.length < 1000) throw new Error(`External source too small: ${source.url}`);
    const title = cleanHtmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || source.expectedTitle;
    return {
      query: source.query,
      title,
      url: source.url,
      insight: source.insight,
      source: "public_web_fetch",
      contentLength: html.length,
      fetchedAt,
    };
  }
}

function buildWebSearchQueries(message: string) {
  const compact = message.replace(/\s+/g, "");
  const queries: string[] = [];
  if (/(签到|打卡|积分|奖励|奖品|权益|活动)/.test(compact)) {
    queries.push("签到积分活动 会员运营 最佳实践");
    queries.push("积分权益 发放 幂等 风控 资损");
    queries.push("营销活动 连续签到 奖励机制 用户体验");
  }
  if (/(原型|prototype|页面|界面|交互)/i.test(message)) {
    queries.push("后台活动配置 前台签到页 原型 交互状态");
  }
  return [...new Set(queries)].slice(0, 4);
}

function buildExternalSources(searchQueries: string[]): ExternalResearchSource[] {
  return [
    {
      query: searchQueries[0] ?? "签到积分活动 会员运营 最佳实践",
      url: "https://mailchimp.com/resources/loyalty-programs/",
      expectedTitle: "Building an Effective Loyalty Program",
      insight: "会员/忠诚度体系通常使用积分、等级或权益承载奖励，适合签到领积分活动的积分账户、奖励展示和兑换规则设计。",
    },
    {
      query: searchQueries[1] ?? "积分权益 发放 幂等 风控 资损",
      url: "https://docs.stripe.com/api/idempotent_requests",
      expectedTitle: "Idempotent requests",
      insight: "公开支付 API 文档强调幂等请求可安全重试，适合积分发放流水号、防重复发奖和补偿重试设计。",
    },
    {
      query: searchQueries[1] ?? "积分权益 发放 幂等 风控 资损",
      url: "https://developer.mozilla.org/en-US/docs/Glossary/Idempotent",
      expectedTitle: "Idempotent",
      insight: "MDN 对幂等的说明可补充签到提交接口的防重语义：同一业务请求重复执行不应改变最终业务结果。",
    },
    {
      query: searchQueries[1] ?? "积分权益 发放 幂等 风控 资损",
      url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429",
      expectedTitle: "429 Too Many Requests",
      insight: "HTTP 429 公开资料可补充高频请求治理，用于异常签到频率、接口保护和防刷提示设计。",
    },
  ];
}

function cacheKeyForQueries(searchQueries: string[]) {
  return searchQueries.map((item) => item.trim()).filter(Boolean).sort().join("\n");
}

function cloneResearchContext(context: ExternalResearchContext, cacheHit: boolean): ExternalResearchContext {
  return {
    ...context,
    searchQueries: [...context.searchQueries],
    refs: context.refs.map((item) => ({ ...item })),
    failures: context.failures.map((item) => ({ ...item })),
    privacyBoundary: [...context.privacyBoundary],
    cacheHit,
  };
}

async function fetchText(url: string, parentSignal?: AbortSignal) {
  if (parentSignal?.aborted) throw new Error("External research aborted");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), readNumberEnv("EXTERNAL_RESEARCH_TIMEOUT_MS", 10_000));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html, text/plain, application/xhtml+xml",
        "user-agent": "ai-product-workbench-external-research/0.1",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

function cleanHtmlText(value: unknown) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
