import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { RequestMeta } from "../auth/auth.types";

export const CurrentRequestMeta = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestMeta => {
    const request = context.switchToHttp().getRequest<Request>();
    return {
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    };
  },
);
