import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectDuplicatesService } from "./project-duplicates.service.js";
import { ProjectMembersService } from "./project-members.service.js";
import { ProjectInvitationTokenService } from "./project-invitation-token.service.js";
import { ProjectInvitationsController } from "./project-invitations.controller.js";
import { ProjectInvitationsService } from "./project-invitations.service.js";
import { ProjectsService } from "./projects.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [ProjectsController, ProjectInvitationsController],
  providers: [
    ProjectsService,
    ProjectMembersService,
    ProjectDuplicatesService,
    ProjectInvitationTokenService,
    ProjectInvitationsService,
  ],
})
export class ProjectsModule {}
