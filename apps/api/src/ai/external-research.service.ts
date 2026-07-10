import { Injectable } from "@nestjs/common";

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
  status: "delegated_to_agent" | "skipped_not_needed" | "failed_non_blocking" | "failed";
  fetchedAt: string;
  searchQueries: string[];
  refs: ExternalResearchReference[];
  failures: Array<{
    query?: string;
    url?: string;
    error: string;
  }>;
  privacyBoundary: string[];
};

const PRIVACY_BOUNDARY = [
  "只搜索通用领域词，不发送知识库路径、内部文件路径、附件原文、会话 ID、用户 ID、真实接口或密钥。",
  "外部资料只补充行业惯例、体验参考和通用风险，不覆盖用户输入、当前设计状态或本地知识库规则。",
  "只记录实际使用的公开来源标题、URL 和简短归纳，不把网页全文写入需求文档或原型。",
];

@Injectable()
export class ExternalResearchService {
  async research(input: {
    message: string;
    knowledgeHitCount: number;
    signal?: AbortSignal;
  }): Promise<ExternalResearchContext> {
    const fetchedAt = new Date().toISOString();
    if (input.knowledgeHitCount <= 0 || input.signal?.aborted) {
      return {
        status: "skipped_not_needed",
        fetchedAt,
        searchQueries: [],
        refs: [],
        failures: [],
        privacyBoundary: [...PRIVACY_BOUNDARY],
      };
    }

    // DeerFlow owns search because it can derive queries from the complete turn,
    // retrieved knowledge, and current design state. The API must not prefetch a
    // fixed set of sources for one sample domain and inject them into every task.
    return {
      status: "delegated_to_agent",
      fetchedAt,
      searchQueries: [],
      refs: [],
      failures: [],
      privacyBoundary: [...PRIVACY_BOUNDARY],
    };
  }
}
