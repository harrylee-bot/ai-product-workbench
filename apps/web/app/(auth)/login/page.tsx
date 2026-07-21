import { connection } from "next/server";

import { isWorkbenchEnterpriseSsoEnabled } from "@/lib/auth/workbench-enterprise-sso-policy";

import { LoginPage } from "./login-page";

export default async function Page() {
  await connection();
  return (
    <LoginPage enterpriseSsoEnabled={isWorkbenchEnterpriseSsoEnabled()} />
  );
}
