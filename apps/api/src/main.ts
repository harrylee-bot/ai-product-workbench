import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/http-exception.filter";
import { validateSecrets } from "./common/secret-config";

function corsOrigin(): string | string[] {
  // 不再回退 true（允许任意来源）。WEB_ORIGIN 必须显式配置，否则启动失败。
  const origin = process.env.WEB_ORIGIN;
  if (!origin) {
    throw new Error("Missing WEB_ORIGIN. Set it to the web app origin(s) in .env (comma-separated).");
  }
  return origin.split(",").map((item) => item.trim());
}

async function bootstrap() {
  validateSecrets();

  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api");
  app.enableCors({
    origin: corsOrigin(),
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
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
