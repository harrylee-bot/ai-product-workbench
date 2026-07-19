type WorkbenchRouteLocation = Pick<Location, "href">;

export function currentWorkbenchRouteHref(
  location: WorkbenchRouteLocation = window.location,
): string {
  const current = new URL(location.href);
  return `${current.pathname}${current.search}${current.hash}`;
}

export function normalizeWorkbenchRouteHref(
  href: string,
  location: WorkbenchRouteLocation = window.location,
): string {
  const current = new URL(location.href);
  const destination = new URL(href, current);
  if (destination.origin !== current.origin) {
    throw new Error("Cannot navigate the Workbench to another origin");
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function workbenchRouteIsCommitted(
  href: string,
  location: WorkbenchRouteLocation = window.location,
): boolean {
  return normalizeWorkbenchRouteHref(href, location) === currentWorkbenchRouteHref(location);
}
