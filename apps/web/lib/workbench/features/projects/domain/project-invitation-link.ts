import { projectInvitationTokenSchema } from "@workbench/workbench-contracts";

export const projectInvitationTokenStorageKey = "workbench.project-invitation-token.v1";

export function projectInvitationAcceptPath(token: string) {
  const validToken = projectInvitationTokenSchema.parse(token);
  return `/invitations/accept#token=${encodeURIComponent(validToken)}`;
}

export function projectInvitationAcceptUrl(token: string, origin: string) {
  const normalizedOrigin = new URL(origin);
  if (
    !/^https?:$/.test(normalizedOrigin.protocol)
    || normalizedOrigin.username
    || normalizedOrigin.password
    || normalizedOrigin.pathname !== "/"
    || normalizedOrigin.search
    || normalizedOrigin.hash
  ) {
    throw new Error("Invitation link origin must be an HTTP(S) origin");
  }
  return new URL(projectInvitationAcceptPath(token), normalizedOrigin).toString();
}

export function projectInvitationTokenFromHash(hash: string) {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(rawHash).get("token");
  const parsed = projectInvitationTokenSchema.safeParse(token ?? "");
  return parsed.success ? parsed.data : null;
}

export function projectInvitationTokenScope(token: string) {
  const validToken = projectInvitationTokenSchema.parse(token);
  return validToken.slice("wbi_".length, validToken.indexOf("."));
}
