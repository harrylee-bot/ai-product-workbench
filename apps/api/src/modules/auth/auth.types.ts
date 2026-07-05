import { UserRole, UserStatus } from "@prisma/client";

export type AuthJwtPayload = {
  sub: string;
  userId: string;
  role: UserRole;
};

export type AuthenticatedUser = {
  id: string;
  email?: string | null;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};
