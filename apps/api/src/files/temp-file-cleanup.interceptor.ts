import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { rm } from "node:fs/promises";
import { catchError, from, mergeMap, type Observable, throwError } from "rxjs";

@Injectable()
export class TempFileCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) =>
        from(cleanupRequestFiles(context.switchToHttp().getRequest())).pipe(
          mergeMap(() => throwError(() => error)),
        ),
      ),
    );
  }
}

async function cleanupRequestFiles(request: { files?: Express.Multer.File[] }) {
  const files = Array.isArray(request.files) ? request.files : [];
  await Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
}
