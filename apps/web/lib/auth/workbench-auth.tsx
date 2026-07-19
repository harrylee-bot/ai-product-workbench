"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";

import { workbenchAuthClient } from "./workbench-auth.client";
import {
  isEmailLoginIdentifier,
  WORKBENCH_OIDC_PROVIDER_ID,
} from "./workbench-auth.shared";

export type WorkbenchUser = {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  displayUsername?: string | null;
  image?: string | null;
};

type WorkbenchAuthContextValue = {
  user: WorkbenchUser | null;
  loading: boolean;
  loginWithOidc: (callbackURL?: string) => Promise<void>;
  login: (input: { account: string; password: string }) => Promise<WorkbenchUser>;
  register: (input: {
    username: string;
    email?: string;
    password: string;
    displayName?: string;
  }) => Promise<WorkbenchUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const WorkbenchAuthContext = createContext<WorkbenchAuthContextValue | null>(null);

export function WorkbenchAuthProvider({ children }: { children: ReactNode }) {
  const session = workbenchAuthClient.useSession();
  const user = session.data?.user ? normalizeUser(session.data.user) : null;

  const loginWithOidc = useCallback(async (callbackURL = "/") => {
    const result = await workbenchAuthClient.signIn.oauth2({
      providerId: WORKBENCH_OIDC_PROVIDER_ID,
      callbackURL,
      errorCallbackURL: "/login?error=oidc",
    });
    if (result.error) throw new Error(result.error.message || "OIDC sign-in failed");
  }, []);

  const login = useCallback(async (input: { account: string; password: string }) => {
    const account = input.account.trim();
    const result = isEmailLoginIdentifier(account)
      ? await workbenchAuthClient.signIn.email({ email: account, password: input.password })
      : await workbenchAuthClient.signIn.username({ username: account, password: input.password });
    if (result.error || !result.data?.user) {
      throw new Error(result.error?.message || "Sign-in failed");
    }
    await session.refetch();
    return normalizeUser(result.data.user);
  }, [session]);

  const register = useCallback(async (input: {
    username: string;
    email?: string;
    password: string;
    displayName?: string;
  }) => {
    if (!input.email) throw new Error("Email is required");
    const username = input.username.trim();
    const displayUsername = input.displayName?.trim() || username;
    const result = await workbenchAuthClient.signUp.email({
      email: input.email,
      password: input.password,
      name: displayUsername,
      username,
      displayUsername,
    });
    if (result.error || !result.data?.user) {
      throw new Error(result.error?.message || "Registration failed");
    }
    await session.refetch();
    return normalizeUser(result.data.user);
  }, [session]);

  const logout = useCallback(async () => {
    const result = await workbenchAuthClient.signOut();
    if (result.error) throw new Error(result.error.message || "Sign-out failed");
    await session.refetch();
  }, [session]);

  const refresh = useCallback(async () => {
    await session.refetch();
  }, [session]);

  const value = useMemo<WorkbenchAuthContextValue>(() => ({
    user,
    loading: session.isPending,
    loginWithOidc,
    login,
    register,
    logout,
    refresh,
  }), [login, loginWithOidc, logout, refresh, register, session.isPending, user]);

  return (
    <WorkbenchAuthContext.Provider value={value}>
      {children}
    </WorkbenchAuthContext.Provider>
  );
}

export function useWorkbenchAuth(): WorkbenchAuthContextValue {
  const context = useContext(WorkbenchAuthContext);
  if (!context) {
    throw new Error("useWorkbenchAuth must be used within WorkbenchAuthProvider");
  }
  return context;
}

function normalizeUser(user: {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  displayUsername?: string | null;
  image?: string | null;
}): WorkbenchUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    displayUsername: user.displayUsername,
    image: user.image,
  };
}
