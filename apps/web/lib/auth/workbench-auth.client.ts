"use client";

import {
  genericOAuthClient,
  usernameClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const workbenchAuthClient = createAuthClient({
  plugins: [usernameClient(), genericOAuthClient()],
});
