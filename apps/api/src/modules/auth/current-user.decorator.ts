import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Phase1User } from "./auth.types";

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Phase1User => {
    const request = context.switchToHttp().getRequest<{ user: Phase1User }>();
    return request.user;
  },
);
