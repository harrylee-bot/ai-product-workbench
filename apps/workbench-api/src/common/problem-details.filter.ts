import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { problemDetailsSchema } from "@workbench/workbench-contracts";

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = response.getHeader("X-Request-ID")?.toString();

    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }

    const problem = this.toProblem(exception, request, requestId);
    if (problem.status >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`${request.method} ${request.originalUrl}: ${problem.detail ?? problem.title}`, stack);
    }

    response
      .status(problem.status)
      .type("application/problem+json")
      .json(problem);
  }

  private toProblem(exception: unknown, request: Request, requestId?: string) {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const parsed = problemDetailsSchema.safeParse(body);
      if (parsed.success) {
        return {
          ...parsed.data,
          instance: parsed.data.instance ?? request.originalUrl,
          requestId: parsed.data.requestId ?? requestId,
        };
      }

      const detail = typeof body === "string"
        ? body
        : readExceptionMessage(body) ?? exception.message;
      return {
        type: "about:blank",
        title: httpTitle(status),
        status,
        detail,
        instance: request.originalUrl,
        code: `HTTP_${status}`,
        requestId,
      };
    }

    return {
      type: "about:blank",
      title: "Internal Server Error",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: "The server could not complete the request",
      instance: request.originalUrl,
      code: "INTERNAL_ERROR",
      requestId,
    };
  }
}

function readExceptionMessage(body: object) {
  if (!("message" in body)) return undefined;
  const message = body.message;
  if (Array.isArray(message)) return String(message[0] ?? "Request failed");
  return typeof message === "string" ? message : undefined;
}

function httpTitle(status: number) {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 412) return "Precondition Failed";
  if (status === 428) return "Precondition Required";
  if (status === 429) return "Too Many Requests";
  return status >= 500 ? "Internal Server Error" : "Request Failed";
}
