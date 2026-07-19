import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { passportJwtSecret } from "jwks-rsa";
import { IdentityService } from "./identity.service.js";

const WORKBENCH_CANONICAL_CLIENT_IP_HEADER = "x-workbench-client-ip";
const INTERNAL_JWKS_CLIENT_IP = "127.0.0.1";

type OidcPayload = {
  sub?: string;
  iss?: string;
  email?: string;
  email_verified?: boolean;
  emailVerified?: boolean;
  name?: string;
  preferred_username?: string;
};

@Injectable()
export class OidcJwtStrategy extends PassportStrategy(Strategy, "workbench-jwt") {
  constructor(config: ConfigService, private readonly identity: IdentityService) {
    const issuer = config.get<string>("OIDC_ISSUER") || "urn:workbench:unconfigured";
    const audience = config.get<string>("OIDC_AUDIENCE") || "workbench";
    const jwksUri = config.get<string>("OIDC_JWKS_URL") || "http://127.0.0.1/.well-known/jwks.json";
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      issuer,
      audience,
      algorithms: ["RS256"],
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        cacheMaxAge: 10 * 60 * 1_000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri,
        requestHeaders: {
          [WORKBENCH_CANONICAL_CLIENT_IP_HEADER]: INTERNAL_JWKS_CLIENT_IP,
        },
      }),
    });
  }

  async validate(payload: OidcPayload) {
    if (!payload.sub || !payload.iss) throw new UnauthorizedException("The access token has no subject");
    return this.identity.resolvePrincipal({
      issuer: payload.iss,
      subject: payload.sub,
      email: payload.email_verified === true || payload.emailVerified === true
        ? payload.email
        : null,
      displayName: payload.name ?? payload.preferred_username,
    });
  }
}
