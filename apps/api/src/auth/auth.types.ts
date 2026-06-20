import type { UserRole, UserStatus } from "@prisma/client";

export type PublicUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};

export type AuthenticatedUser = PublicUser;

export type JwtPayload = {
  sub: string;
  userId: string;
  role: UserRole;
};

export type RequestMeta = {
  ip?: string;
  userAgent?: string;
};
