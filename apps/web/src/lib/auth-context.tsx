"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError, apiRequest, assertWorkbenchApiAvailable } from "./api";
import { clearSession } from "./auth-storage";
import type { LoginResponse, PublicUser } from "./types";

type AuthContextValue = {
  user: PublicUser | null;
  loading: boolean;
  expiredMessage: string | null;
  login: (account: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  clearExpiredMessage: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [expiredMessage, setExpiredMessage] = useState<string | null>(null);

  const applyUser = useCallback((nextUser: PublicUser | null) => {
    setUser(nextUser);
    if (!nextUser) clearSession();
  }, []);

  const refreshMe = useCallback(async () => {
    await assertWorkbenchApiAvailable();
    const nextUser = await apiRequest<PublicUser>("/auth/me");
    applyUser(nextUser);
  }, [applyUser]);

  useEffect(() => {
    assertWorkbenchApiAvailable()
      .then(() => apiRequest<PublicUser>("/auth/me", { suppressAuthExpiredEvent: true }))
      .then((nextUser) => {
        applyUser(nextUser);
      })
      .catch((error: Error) => {
        applyUser(null);
        if (!(error instanceof ApiError) || error.status !== 401) {
          setExpiredMessage(error.message);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, [applyUser]);

  useEffect(() => {
    const handleExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      applyUser(null);
      setExpiredMessage(detail?.message ?? "登录状态已失效，请重新登录");
    };

    window.addEventListener("auth:expired", handleExpired);
    return () => window.removeEventListener("auth:expired", handleExpired);
  }, [applyUser]);

  const login = useCallback(
    async (account: string, password: string) => {
      await assertWorkbenchApiAvailable();
      const result = await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ account, password }),
      });
      applyUser(result.user);
      setExpiredMessage(null);
    },
    [applyUser],
  );

  const logout = useCallback(async () => {
    await apiRequest<{ success: true }>("/auth/logout", { method: "POST" }).catch(() => null);
    applyUser(null);
  }, [applyUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      expiredMessage,
      login,
      logout,
      refreshMe,
      clearExpiredMessage: () => setExpiredMessage(null),
    }),
    [expiredMessage, loading, login, logout, refreshMe, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}
