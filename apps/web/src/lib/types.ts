export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";

export type PublicUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};

export type Session = {
  accessToken: string;
  user: PublicUser;
};

export type LoginResponse = Session;

export type AdminUser = {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type UsersResponse = {
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
};
