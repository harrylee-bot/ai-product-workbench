import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { WorkspaceMembersController } from "./workspace-members.controller.js";
import { WorkspaceMembersService } from "./workspace-members.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [WorkspaceMembersController],
  providers: [WorkspaceMembersService],
})
export class WorkspacesModule {}
