type AuthAccountWrite = Record<string, unknown> & {
  idToken?: unknown;
};

export function discardStoredOidcIdToken<T extends AuthAccountWrite>(account: T): T & { idToken: null } {
  return { ...account, idToken: null };
}
