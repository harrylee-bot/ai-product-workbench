import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { initializeTelemetry, startHttpServerSpan } from "@workbench/workbench-telemetry";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { ProblemDetailsFilter } from "./common/problem-details.filter.js";
import { configureWorkbenchRequestBody } from "./common/request-body.js";

const telemetry = initializeTelemetry({ serviceName: "workbench-api" });

function validateConfiguration() {
  if (!process.env.WORKBENCH_DATABASE_URL) {
    throw new Error("Missing WORKBENCH_DATABASE_URL");
  }
  if (!process.env.WORKBENCH_WEB_ORIGIN) {
    throw new Error("Missing WORKBENCH_WEB_ORIGIN");
  }
  if (!process.env.WORKBENCH_INVITATION_TOKEN_SECRET?.trim()) {
    throw new Error("Missing WORKBENCH_INVITATION_TOKEN_SECRET");
  }
  for (const name of ["DEERFLOW_LANGGRAPH_URL", "DEERFLOW_INTERNAL_AUTH_TOKEN"] as const) {
    if (!process.env[name]?.trim()) throw new Error(`Missing ${name}`);
  }

  const authMode = process.env.WORKBENCH_AUTH_MODE || "oidc";
  if (process.env.NODE_ENV === "production" && authMode === "development") {
    throw new Error("WORKBENCH_AUTH_MODE=development is forbidden in production");
  }
  if (authMode === "oidc") {
    for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URL"] as const) {
      if (!process.env[name]) throw new Error(`Missing ${name}`);
    }
  }
}

async function bootstrap() {
  validateConfiguration();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestSpan = startHttpServerSpan({
      method: request.method,
      route: "/api/v1/*",
      headers: request.headers,
    });
    response.once("finish", () => requestSpan.end(response.statusCode));
    response.once("close", () => {
      if (!response.writableFinished) requestSpan.end(response.statusCode, true);
    });
    requestSpan.run(() => {
      try {
        next();
      } catch (error) {
        requestSpan.fail();
        throw error;
      }
    });
  });
  configureWorkbenchRequestBody(app);
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  }));
  app.use((_request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    response.setHeader("X-Request-ID", requestId);
    next();
  });
  app.enableCors({
    origin: process.env.WORKBENCH_WEB_ORIGIN!.split(",").map((origin) => origin.trim()).filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Accept",
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "If-Match",
      "If-None-Match",
      "Last-Event-ID",
      "Traceparent",
      "Tracestate",
      "X-Workbench-Dev-Email",
      "X-Workbench-Dev-Name",
      "X-Workbench-Dev-Subject",
    ],
    exposedHeaders: ["ETag", "Location", "X-Request-ID"],
  });
  app.useGlobalFilters(new ProblemDetailsFilter());

  const port = Number(process.env.WORKBENCH_API_PORT || 4100);
  const host = process.env.WORKBENCH_API_HOST || "127.0.0.1";
  await app.listen(port, host);
}

void bootstrap().catch(async (error) => {
  await telemetry.shutdown().catch(() => undefined);
  console.error("[workbench-api] fatal", error);
  process.exitCode = 1;
});
