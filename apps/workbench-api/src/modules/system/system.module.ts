import { Module } from "@nestjs/common";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { SystemController } from "./system.controller.js";

@Module({ imports: [KnowledgeModule, RuntimeModule], controllers: [SystemController] })
export class SystemModule {}
