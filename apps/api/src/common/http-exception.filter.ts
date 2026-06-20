import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

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

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      message: "登录失败，请稍后重试",
    });
  }

  private readMessage(value: unknown) {
    if (!value || typeof value !== "object") return "请求失败";
    const message = (value as { message?: unknown }).message;
    if (Array.isArray(message)) return String(message[0] ?? "请求失败");
    return typeof message === "string" ? message : "请求失败";
  }
}
