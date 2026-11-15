import { RunsModule } from "../runs/runs.module.js";
import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PrototypeV2Controller, PublicPrototypeV2Controller } from "./prototype-v2.controller.js";
import { PrototypeV2Service, PrototypeWorkflowClient } from "./prototype-v2.service.js";
import { PrototypeArtifactStorageReader } from "./prototype-artifact-storage.reader.js";

@Module({
  imports: [AccessModule, IdentityModule, RunsModule],
  controllers: [PrototypeV2Controller, PublicPrototypeV2Controller],
  providers: [PrototypeV2Service, PrototypeWorkflowClient, PrototypeArtifactStorageReader, { provide: "PrototypeWorkflowClientPort", useExisting: PrototypeWorkflowClient }],
  exports: [PrototypeV2Service],
})
export class PrototypesModule {}
