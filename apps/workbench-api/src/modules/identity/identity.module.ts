import { Module } from "@nestjs/common";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { OidcJwtStrategy } from "./oidc-jwt.strategy.js";
import { WorkbenchAuthGuard } from "./workbench-auth.guard.js";
import { CommunicationPreferencesService } from "./communication-preferences.service.js";

@Module({
  controllers: [IdentityController],
  providers: [CommunicationPreferencesService, IdentityService, OidcJwtStrategy, WorkbenchAuthGuard],
  exports: [CommunicationPreferencesService, IdentityService, WorkbenchAuthGuard],
})
export class IdentityModule {}
