import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import {
  knowledgeToolRequestSchema,
  type KnowledgeToolRequest,
} from "@workbench/workbench-contracts";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { KnowledgeToolService } from "./knowledge-tool.service.js";

@Controller("runtime/knowledge")
export class KnowledgeToolController {
  constructor(private readonly knowledge: KnowledgeToolService) {}

  @Post("retrieve")
  @HttpCode(200)
  retrieve(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(knowledgeToolRequestSchema)) body: KnowledgeToolRequest,
  ) {
    return this.knowledge.retrieve(authorization, idempotencyKey, body);
  }
}
