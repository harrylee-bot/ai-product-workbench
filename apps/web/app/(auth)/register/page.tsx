import { redirect } from "next/navigation";
import { connection } from "next/server";

import {
  authRouteWithReturnPath,
  safeAuthReturnPath,
} from "@/lib/auth/auth-return-path";
import { isWorkbenchPublicRegistrationEnabled } from "@/lib/auth/workbench-registration-policy";

import { RegisterPage } from "./register-page";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  await connection();
  const { next } = await searchParams;
  const nextPath = safeAuthReturnPath(typeof next === "string" ? next : null);

  if (!isWorkbenchPublicRegistrationEnabled()) {
    redirect(authRouteWithReturnPath("/login", nextPath));
  }

  return <RegisterPage />;
}
