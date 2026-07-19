import type { PreviewService } from "./preview.service.js";

type PreviewRequestService = Pick<PreviewService, "resolve" | "render">;

export async function preparePreviewResponse(
  service: PreviewRequestService,
  input: {
    token: string;
    method: "GET" | "HEAD";
    ifNoneMatch?: string;
  },
  signal?: AbortSignal,
) {
  const resolved = await service.resolve(input.token);
  if (entityTagMatches(input.ifNoneMatch, resolved.etag)) {
    return { status: 304 as const, etag: resolved.etag };
  }
  if (input.method === "HEAD") {
    return { status: 200 as const, etag: resolved.etag, head: true as const };
  }
  return {
    status: 200 as const,
    etag: resolved.etag,
    head: false as const,
    preview: await service.render(resolved, signal),
  };
}

function entityTagMatches(header: string | undefined, etag: string) {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}
