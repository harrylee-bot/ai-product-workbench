export const WORKBENCH_OIDC_PROVIDER_ID = "workbench-oidc";
export const WORKBENCH_USERNAME_MIN_LENGTH = 3;
export const WORKBENCH_USERNAME_MAX_LENGTH = 30;
export const WORKBENCH_PASSWORD_MIN_LENGTH = 8;
export const WORKBENCH_PASSWORD_MAX_LENGTH = 128;

export function isWorkbenchUsername(value: string): boolean {
  return (
    value.length >= WORKBENCH_USERNAME_MIN_LENGTH
    && value.length <= WORKBENCH_USERNAME_MAX_LENGTH
    && /^[a-zA-Z0-9_.-]+$/.test(value)
  );
}

export function isWorkbenchEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function isEmailLoginIdentifier(value: string): boolean {
  return value.includes("@");
}
