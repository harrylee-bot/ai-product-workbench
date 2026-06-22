import { UserRole, UserStatus } from "@prisma/client";

export type Phase1JwtPayload = {
  sub: string;
  userId: string;
  role: UserRole;
};

export type Phase1User = {
  id: string;
  email?: string | null;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};
