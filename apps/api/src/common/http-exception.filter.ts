	import {
	  ArgumentsHost,
	  Catch,
	  ExceptionFilter,
	  HttpException,
	  HttpStatus,
	  Logger,
	} from "@nestjs/common";
	import type { Request, Response } from "express";

	@Catch()
	export class HttpExceptionFilter implements ExceptionFilter {
	  private readonly logger = new Logger(HttpExceptionFilter.name);

	  catch(exception: unknown, host: ArgumentsHost) {
	    const http = host.switchToHttp();
	    const response = http.getResponse<Response>();
	    if (response.headersSent) {
	      if (!response.writableEnded) response.end();
	      return;
	    }

	    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      const message =
        typeof exceptionResponse === "string"
          ? exceptionResponse
          : this.readMessage(exceptionResponse);

      response.status(status).json({ message });
	      return;
	    }

	    const request = http.getRequest<Request>();
	    const method = request?.method ?? "UNKNOWN";
	    const url = request?.originalUrl ?? request?.url ?? "unknown-url";
	    const message = exception instanceof Error ? exception.message : String(exception);
	    const stack = exception instanceof Error ? exception.stack : undefined;
	    this.logger.error(`Unhandled exception ${method} ${url}: ${message}`, stack);

	    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
	      message: "服务器内部错误，请稍后重试",
    });
  }

  private readMessage(value: unknown) {
    if (!value || typeof value !== "object") return "请求失败";
    const message = (value as { message?: unknown }).message;
    if (Array.isArray(message)) return String(message[0] ?? "请求失败");
    return typeof message === "string" ? message : "请求失败";
  }
}
