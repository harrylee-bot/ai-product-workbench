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
const LOCAL_DEMO_EMAIL = "stitch@local.dev";
const LOCAL_DEMO_PASSWORD = "stitch123456";
const LOCAL_DEMO_COOKIE = "access_token";
const LOCAL_DEMO_STORAGE_KEY = "stitch-local-demo-user";
const LOCAL_DEMO_USER: NestUser = {
  id: "local-stitch-preview",
  username: "stitch-preview",
  email: LOCAL_DEMO_EMAIL,
  displayName: "Stitch Preview",
  role: "user",
  status: "active",
};

function normalizeSessionResponse(data: { user?: NestUser | null } | NestUser): NestUser | null {
  if ("user" in data) return data.user ?? null;
  return data as NestUser;
}

function isLocalDemoEnabled() {
  return process.env.NODE_ENV !== "production";
}

function readLocalDemoUser(): NestUser | null {
  if (!isLocalDemoEnabled() || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LOCAL_DEMO_STORAGE_KEY)
      ? LOCAL_DEMO_USER
      : null;
  } catch {
    return null;
  }
}

function writeLocalDemoUser() {
  if (!isLocalDemoEnabled() || typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_DEMO_STORAGE_KEY, "1");
  document.cookie = `${LOCAL_DEMO_COOKIE}=local-stitch-preview; path=/; max-age=604800; SameSite=Lax`;
}

function clearLocalDemoUser() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LOCAL_DEMO_STORAGE_KEY);
  document.cookie = `${LOCAL_DEMO_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

function matchesLocalDemoLogin(input: { email: string; password: string }) {
  return (
    isLocalDemoEnabled() &&
    input.email.trim().toLowerCase() === LOCAL_DEMO_EMAIL &&
    input.password === LOCAL_DEMO_PASSWORD
  );
}

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
    const localDemoUser = readLocalDemoUser();
    if (localDemoUser) {
      setUser(localDemoUser);
      setLoading(false);
      return;
    }

    try {
      const data = await request<{ user?: NestUser | null } | NestUser>("/auth/session");
      setUser(normalizeSessionResponse(data));
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
      try {
        const data = await request<{ user: NestUser }>("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
        setUser(data.user);
        return data.user;
      } catch (error) {
        if (!matchesLocalDemoLogin(input)) throw error;
        writeLocalDemoUser();
        setUser(LOCAL_DEMO_USER);
        return LOCAL_DEMO_USER;
      }
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
    clearLocalDemoUser();
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
