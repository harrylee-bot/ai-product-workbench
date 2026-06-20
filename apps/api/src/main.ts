import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/http-exception.filter";

function corsOrigin() {
  const origin = process.env.WEB_ORIGIN;
  if (!origin) return true;
  return origin.split(",").map((item) => item.trim());
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api");
  app.enableCors({
    origin: corsOrigin(),
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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
