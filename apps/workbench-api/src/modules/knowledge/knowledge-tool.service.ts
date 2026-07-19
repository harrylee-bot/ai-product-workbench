import { Injectable } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import {
  knowledgeToolResponseSchema,
  type KnowledgeToolRequest,
  type KnowledgeToolResponse,
} from "@workbench/workbench-contracts";
import {
  KnowledgeToolGrantError,
  verifyKnowledgeToolGrant,
} from "@workbench/workbench-knowledge";
import {
  knowledgeGrantUnauthorizedProblem,
  knowledgeRetrievalUnavailableProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { JiebaQuerySegmenterAdapter } from "./jieba-query-segmenter.adapter.js";
import { KnowledgeRetrievalConfig } from "./knowledge-retrieval.config.js";
import { KnowledgeRetrievalService } from "./knowledge-retrieval.service.js";
import { KnowledgeRetrievalError } from "./knowledge-retrieval.types.js";
import { PrismaKnowledgeRetrievalStore } from "./prisma-knowledge-retrieval.store.js";
import { TeiQueryEmbeddingAdapter } from "./tei-query-embedding.adapter.js";
import { TeiRerankerAdapter } from "./tei-reranker.adapter.js";
import {
  KnowledgeToolLedgerService,
  type KnowledgeToolReservation,
} from "./knowledge-tool-ledger.service.js";

@Injectable()
export class KnowledgeToolService {
  private readonly logger = new Logger(KnowledgeToolService.name);
  private readonly retrieval: KnowledgeRetrievalService | null;

  constructor(
    private readonly config: KnowledgeRetrievalConfig,
    private readonly access: AccessService,
    private readonly db: WorkbenchDbService,
    private readonly ledger: KnowledgeToolLedgerService,
  ) {
    this.retrieval = config.providers
      ? new KnowledgeRetrievalService(
          access,
          new PrismaKnowledgeRetrievalStore(db),
          {
            segmenter: new JiebaQuerySegmenterAdapter(),
            queryEmbedding: new TeiQueryEmbeddingAdapter(config.providers.embedding),
            reranker: new TeiRerankerAdapter(config.providers.reranker),
          },
        )
      : null;
  }

  async retrieve(
    authorization: string | undefined,
    idempotencyKey: string | undefined,
    request: KnowledgeToolRequest,
  ): Promise<KnowledgeToolResponse> {
    const grant = this.verifyGrant(authorization);
    if (!this.retrieval || !this.config.providers) {
      throw knowledgeRetrievalUnavailableProblem(
        "KNOWLEDGE_RETRIEVAL_NOT_CONFIGURED",
        "Production Knowledge retrieval providers are not configured",
      );
    }
    const reserved = await this.ledger.reserve(grant, idempotencyKey, request.query);
    if (reserved.kind === "replay") return reserved.response;
    const { reservation } = reserved;

    try {
      const result = await this.retrieval.retrieve({
        principalId: grant.principalId,
        projectId: grant.projectId,
        releaseId: grant.releaseId,
        query: request.query,
        mode: grant.mode,
        routeScope: grant.routeScope,
      });
      const response = knowledgeToolResponseSchema.safeParse({
        protocol: "workbench.knowledge-retrieval-result.v1",
        evidence: result.evidence,
        items: result.items.map((item) => ({
          rank: item.rank,
          rrfScore: item.rrfScore,
          rerankerScore: item.rerankerScore,
          citation: {
            id: item.citation.id,
            documentId: item.citation.documentId,
            chunkId: item.citation.chunkId,
            sourcePath: item.citation.sourcePath,
            title: item.citation.title,
            quote: item.citation.quote,
            locator: {
              heading: item.citation.locator.headingPath.length > 0
                ? item.citation.locator.headingPath.join(" / ")
                : null,
              startLine: null,
              endLine: null,
            },
          },
        })),
      });
      if (!response.success) {
        throw new KnowledgeRetrievalError(
          "KNOWLEDGE_RETRIEVAL_INTEGRITY_ERROR",
          "Knowledge retrieval produced an invalid citation result",
          { cause: response.error },
        );
      }
      return await this.ledger.commit(grant, reservation, response.data);
    } catch (error) {
      await this.release(reservation, error);
      if (error instanceof KnowledgeRetrievalError) throw retrievalProblem(error);
      throw error;
    }
  }

  private verifyGrant(authorization: string | undefined) {
    if (!this.config.grantSecret) {
      throw knowledgeRetrievalUnavailableProblem(
        "KNOWLEDGE_RETRIEVAL_NOT_CONFIGURED",
        "Knowledge retrieval capability verification is not configured",
      );
    }
    const token = bearerToken(authorization);
    try {
      return verifyKnowledgeToolGrant(token, this.config.grantSecret, {
        maximumTtlSeconds: this.config.grantMaximumTtlSeconds,
      });
    } catch (error) {
      if (error instanceof KnowledgeToolGrantError) throw knowledgeGrantUnauthorizedProblem();
      throw error;
    }
  }

  private async release(reservation: KnowledgeToolReservation, error: unknown): Promise<void> {
    const code = error instanceof KnowledgeRetrievalError
      ? error.code
      : isAbortError(error)
        ? "KNOWLEDGE_RETRIEVAL_CANCELLED"
        : "KNOWLEDGE_RETRIEVAL_FAILED";
    try {
      await this.ledger.release(reservation, code);
    } catch (releaseError) {
      this.logger.error("Knowledge invocation reservation release failed", releaseError instanceof Error
        ? releaseError.stack
        : undefined);
    }
  }
}

function bearerToken(value: string | undefined): string {
  if (!value || value.length > 4_103) throw knowledgeGrantUnauthorizedProblem();
  const [scheme, token, extra] = value.split(" ");
  if (scheme !== "Bearer" || !token || extra !== undefined) throw knowledgeGrantUnauthorizedProblem();
  return token;
}

function retrievalProblem(error: KnowledgeRetrievalError) {
  if (error.code === "KNOWLEDGE_QUERY_INVALID") return validationProblem(error.safeDetail);
  if (error.code === "KNOWLEDGE_QUERY_EMBEDDING_FAILED") {
    return knowledgeRetrievalUnavailableProblem(error.code, error.safeDetail);
  }
  if (error.code === "KNOWLEDGE_QUERY_EMBEDDING_INVALID") {
    return knowledgeRetrievalUnavailableProblem(error.code, error.safeDetail, HttpStatus.BAD_GATEWAY);
  }
  return knowledgeRetrievalUnavailableProblem(error.code, error.safeDetail);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "The operation was aborted");
}
