import { ObjectStorageModule } from "../../platform/object-storage/object-storage.module.js";
import { RequirementContextReader } from "./requirement-context-reader.js";
import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { PrototypesModule } from '../prototypes/prototypes.module.js';
import { KnowledgeRetrievalConfig } from '../knowledge/knowledge-retrieval.config.js';
import { RequirementsService } from './requirements.service.js';
import { RequirementsController } from './requirements.controller.js';
import { RequirementModel } from './requirement-model.js';
import { RequirementKnowledge } from './requirement-knowledge.js';
import { RequirementsProcessor } from './requirements.processor.js';
@Module({imports:[ObjectStorageModule,AccessModule,IdentityModule,RunsModule,PrototypesModule],controllers:[RequirementsController],providers:[RequirementContextReader,RequirementsService,RequirementModel,RequirementKnowledge,KnowledgeRetrievalConfig,RequirementsProcessor]})
export class RequirementsModule{}
