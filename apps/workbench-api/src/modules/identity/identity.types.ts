export type AuthenticatedPrincipal = {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  defaultWorkspaceId: string;
};

export type ExternalPrincipalClaims = {
  issuer: string;
  subject: string;
  email?: string | null;
  displayName?: string;
};
