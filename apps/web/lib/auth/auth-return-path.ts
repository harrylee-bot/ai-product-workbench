export function safeAuthReturnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || hasControlCharacter(value)) return "/";
  try {
    const url = new URL(value, "http://local.invalid");
    if (url.origin !== "http://local.invalid") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function authRouteWithReturnPath(route: "/login" | "/register", returnPath: string) {
  return returnPath === "/"
    ? route
    : `${route}?next=${encodeURIComponent(returnPath)}`;
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
