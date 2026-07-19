import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ThreadsController } from "./threads.controller.js";
import { ThreadsService } from "./threads.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [ThreadsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
