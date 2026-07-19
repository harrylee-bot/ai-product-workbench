import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { BoardsController } from "./boards.controller.js";
import { BoardsService } from "./boards.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [BoardsController],
  providers: [BoardsService],
})
export class BoardsModule {}
