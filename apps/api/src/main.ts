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

  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")
    .at(0)
    ?.trim()
    .toLowerCase();
  if (request.secure || forwardedProto === "https") {
    next();
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    response.redirect(308, `https://${request.headers.host ?? ""}${request.originalUrl}`);
    return;
  }

  response.status(403).json({ statusCode: 403, message: "HTTPS_REQUIRED", error: "Forbidden" });
}

async function bootstrap() {
  validateSecrets();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.set("trust proxy", 1);
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.use(enforceHttpsInProduction);
  // sec-2：安全响应头 + CSP。frame-ancestors 'none' 防点击劫持。
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // API 不提供可执行 HTML；原型预览走专用 preview 响应，不放宽全局 script-src。
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

  await app.listen(Number(process.env.API_PORT ?? 4000));
}

void bootstrap();
