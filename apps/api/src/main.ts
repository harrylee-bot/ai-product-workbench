import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { isUserHtmlPreviewPath } from "./ai/user-html-security";
import { HttpExceptionFilter } from "./common/http-exception.filter";
import { validateSecrets } from "./common/secret-config";

function corsOrigin(): string | string[] {
  // 不再回退 true（允许任意来源）。WEB_ORIGIN 必须显式配置，否则启动失败。
  const origin = process.env.WEB_ORIGIN;
  if (!origin) {
    throw new Error("Missing WEB_ORIGIN. Set it to the web app origin(s) in .env (comma-separated).");
  }
  return origin.split(",").map((item) => item.trim()).filter(Boolean);
}

function enforceHttpsInProduction(request: Request, response: Response, next: NextFunction) {
  if (process.env.NODE_ENV !== "production" || process.env.FORCE_HTTPS === "false") {
    next();
    return;
  }

  if (request.secure) {
    next();
    return;
  }

  response.status(403).json({ statusCode: 403, message: "HTTPS_REQUIRED", error: "Forbidden" });
}

function trustedProxySetting(): false | string[] {
  const configured = process.env.TRUST_PROXY?.trim();
  if (!configured || configured.toLowerCase() === "false") return false;
  if (configured === "*" || configured.toLowerCase() === "true") {
    throw new Error("TRUST_PROXY must name trusted proxy addresses or subnets; wildcard trust is not allowed.");
  }
  const entries = configured.split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.length) return false;
  return entries;
}

async function bootstrap() {
  validateSecrets();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.set("trust proxy", trustedProxySetting());
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(enforceHttpsInProduction);
  // sec-2：安全响应头 + CSP。frame-ancestors 'none' 防点击劫持。
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 仅原型预览在无同源权限的 sandbox 中执行内联交互脚本。
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
      hsts: process.env.NODE_ENV === "production"
        ? { maxAge: 15552000, includeSubDomains: true, preload: true }
        : false,
    }),
  );
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isUserHtmlPreviewPath(request.path)) {
      response.removeHeader("X-Frame-Options");
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
    next();
  });
  app.enableCors({
    origin: corsOrigin(),
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "x-vercel-ai-ui-message-stream",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => {
        const firstConstraint = errors
          .flatMap((error) => Object.values(error.constraints ?? {}))
          .at(0);
        return new BadRequestException(firstConstraint ?? "参数错误");
      },
    }),
  );

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST?.trim() || "127.0.0.1";
  await app.listen(port, host);
}

void bootstrap();
