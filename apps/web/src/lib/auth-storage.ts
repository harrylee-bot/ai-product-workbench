const STORAGE_KEY = "ai-product-workbench-session";

export function readSession(): null {
  clearSession();
  return null;
}

export function saveSession(_session: unknown) {
  clearSession();
}

export function clearSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
