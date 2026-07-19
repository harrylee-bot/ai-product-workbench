export type RequestDecorator = (request: Request) => Request | Promise<Request>;

export type WorkbenchFetchOptions = {
  fetch?: (request: Request) => Promise<Response>;
};

const DANGEROUS_IDENTITY_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-workbench-dev-subject",
  "x-workbench-dev-email",
  "x-workbench-dev-name",
] as const;

export function createWorkbenchRequestDecorator(): RequestDecorator {
  return (request) => {
    const headers = new Headers(request.headers);
    for (const name of DANGEROUS_IDENTITY_HEADERS) headers.delete(name);
    return new Request(request, { headers });
  };
}

export function createWorkbenchFetch({
  fetch: fetchImplementation = globalThis.fetch,
}: WorkbenchFetchOptions = {}): (request: Request) => Promise<Response> {
  const decorateRequest = createWorkbenchRequestDecorator();
  return async (request) => {
    const decorated = await decorateRequest(request);
    assertSameOriginBffRequest(decorated);
    return fetchImplementation(new Request(decorated, { credentials: "same-origin" }));
  };
}

function assertSameOriginBffRequest(request: Request): void {
  if (typeof window === "undefined") return;
  const url = new URL(request.url, window.location.origin);
  if (
    url.origin !== window.location.origin
    || (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/"))
  ) {
    throw new Error("Workbench browser requests must use the same-origin /api/v1 BFF");
  }
}
