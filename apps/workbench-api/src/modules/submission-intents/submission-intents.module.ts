import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ImportSourcesModule } from "../import-sources/import-sources.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { SubmissionIntentsController } from "./submission-intents.controller.js";
import { SubmissionIntentsService } from "./submission-intents.service.js";

@Module({
  imports: [AccessModule, IdentityModule, ImportSourcesModule, RunsModule, RuntimeModule],
  controllers: [SubmissionIntentsController],
  providers: [SubmissionIntentsService],
  exports: [SubmissionIntentsService],
})
export class SubmissionIntentsModule {}
