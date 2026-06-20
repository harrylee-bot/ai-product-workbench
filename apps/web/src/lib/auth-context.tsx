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
import { apiRequest, assertWorkbenchApiAvailable } from "./api";
import { clearSession, readSession, saveSession } from "./auth-storage";
import type { LoginResponse, PublicUser, Session } from "./types";

type AuthContextValue = {
  user: PublicUser | null;
  accessToken: string | null;
  loading: boolean;
  expiredMessage: string | null;
  login: (account: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  clearExpiredMessage: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [expiredMessage, setExpiredMessage] = useState<string | null>(null);

  const applySession = useCallback((nextSession: Session | null) => {
    setSession(nextSession);
    if (nextSession) {
      saveSession(nextSession);
    } else {
      clearSession();
    }
  }, []);

  const refreshMe = useCallback(async () => {
    const stored = readSession();
    if (!stored) {
      applySession(null);
      return;
    }

    await assertWorkbenchApiAvailable();
    const user = await apiRequest<PublicUser>("/auth/me", {
      tokenOverride: stored.accessToken,
    });
    applySession({ accessToken: stored.accessToken, user });
  }, [applySession]);

  useEffect(() => {
    const stored = readSession();
    if (!stored) {
      setLoading(false);
      return;
    }

    setSession(stored);
    assertWorkbenchApiAvailable()
      .then(() => apiRequest<PublicUser>("/auth/me", { tokenOverride: stored.accessToken }))
      .then((user) => {
        applySession({ accessToken: stored.accessToken, user });
      })
      .catch((error: Error) => {
        applySession(null);
        setExpiredMessage(error.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [applySession]);

  useEffect(() => {
    const handleExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      applySession(null);
      setExpiredMessage(detail?.message ?? "登录状态已失效，请重新登录");
    };

    window.addEventListener("auth:expired", handleExpired);
    return () => window.removeEventListener("auth:expired", handleExpired);
  }, [applySession]);

  const login = useCallback(
    async (account: string, password: string) => {
      await assertWorkbenchApiAvailable();
      const result = await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ account, password }),
      });
      applySession(result);
      setExpiredMessage(null);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    await apiRequest<{ success: true }>("/auth/logout", { method: "POST" }).catch(() => null);
    applySession(null);
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      accessToken: session?.accessToken ?? null,
      loading,
      expiredMessage,
      login,
      logout,
      refreshMe,
      clearExpiredMessage: () => setExpiredMessage(null),
    }),
    [expiredMessage, loading, login, logout, refreshMe, session],
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
