import { ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";
import { IdentityService } from "./identity.service.js";
import type { AuthenticatedPrincipal } from "./identity.types.js";

@Injectable()
export class WorkbenchAuthGuard extends AuthGuard("workbench-jwt") {
  constructor(
    private readonly config: ConfigService,
    private readonly identity: IdentityService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    if (this.config.get<string>("WORKBENCH_AUTH_MODE") !== "development") {
      return super.canActivate(context) as boolean | Promise<boolean>;
    }

    if (this.config.get<string>("NODE_ENV") === "production") {
      throw new Error("Development authentication cannot run in production");
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const subject = request.header("x-workbench-dev-subject")?.trim();
    if (!subject) throw new UnauthorizedException("Missing x-workbench-dev-subject");
    request.user = await this.identity.resolvePrincipal({
      issuer: "urn:workbench:development",
      subject,
      email: request.header("x-workbench-dev-email")?.trim() || undefined,
      displayName: request.header("x-workbench-dev-name")?.trim() || undefined,
    });
    return true;
  }

  handleRequest<TUser = AuthenticatedPrincipal>(error: unknown, user: TUser) {
    if (error) throw error;
    if (!user) throw new UnauthorizedException("Authentication required");
    return user;
  }
}
