"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { getApiBase } from "@/lib/api/config";

export type NestUser = {
  id: string;
  username: string;
  email?: string | null;
  displayName: string;
  role: string;
  status: string;
};

type AuthContextValue = {
  user: NestUser | null;
  loading: boolean;
  login: (input: { email: string; password: string }) => Promise<NestUser>;
  register: (input: {
    username: string;
    email?: string;
    password: string;
    displayName?: string;
  }) => Promise<NestUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const body = await res.json();
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<NestUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await request<{ user: NestUser }>("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      const data = await request<{ user: NestUser }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: input.email, password: input.password }),
      });
      setUser(data.user);
      return data.user;
    },
    [],
  );

  const register = useCallback(
    async (input: {
      username: string;
      email?: string;
      password: string;
      displayName?: string;
    }) => {
      const data = await request<{ user: NestUser }>("/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setUser(data.user);
      return data.user;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await request("/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout, refresh }),
    [user, loading, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
