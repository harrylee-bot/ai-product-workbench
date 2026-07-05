import type { UserRole, UserStatus } from "@prisma/client";

export type AuthJwtPayload = {
  sub: string;
  userId: string;
  role: UserRole;
};

type PublicUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};

export type AuthenticatedUser = PublicUser;

export type RequestMeta = {
  ip?: string;
  userAgent?: string;
};
